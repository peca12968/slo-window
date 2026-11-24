import java.nio.file.Path;
import java.io.IOException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import jdk.jfr.consumer.RecordingFile;

/** Measure temporal overlap between recorded operations and top-level GC pauses. */
public class PauseLens {
    record Span(long start, long end) {
        Span {
            if (end < start) throw new IllegalArgumentException("Negative interval");
        }
    }

    static class PauseIndex {
        private final List<Span> merged = new ArrayList<>();
        private final long[] prefix;

        PauseIndex(List<Span> pauses) {
            var sorted = new ArrayList<>(pauses);
            sorted.sort(Comparator.comparingLong(Span::start));
            for (Span next : sorted) {
                if (next.start == next.end) continue;
                if (merged.isEmpty() || merged.getLast().end < next.start) {
                    merged.add(next);
                } else {
                    Span last = merged.removeLast();
                    merged.add(new Span(last.start, Math.max(last.end, next.end)));
                }
            }
            prefix = new long[merged.size() + 1];
            for (int i = 0; i < merged.size(); i++) {
                Span span = merged.get(i);
                prefix[i + 1] = Math.addExact(prefix[i], span.end - span.start);
            }
        }

        private long pausedBefore(long instant) {
            int left = 0, right = merged.size();
            while (left < right) {
                int mid = left + (right - left) / 2;
                if (merged.get(mid).end <= instant) left = mid + 1;
                else right = mid;
            }
            long partial = left < merged.size() ? Math.max(0L, instant - merged.get(left).start) : 0;
            return prefix[left] + partial;
        }

        long overlap(Span operation) {
            return pausedBefore(operation.end) - pausedBefore(operation.start);
        }
    }

    static String p95(long[] values, int count) {
        if (count == 0) return "null";
        Arrays.sort(values, 0, count);
        return Long.toString(values[(int)((95L * count - 1) / 100)]);
    }

    static String summarize(List<Span> operations, List<Span> pauses) {
        PauseIndex index = new PauseIndex(pauses);
        long[] durations = new long[operations.size()];
        long[] withPause = new long[operations.size()];
        long[] withoutPause = new long[operations.size()];
        long totalOverlap = 0;
        int affected = 0, unaffected = 0;
        for (int i = 0; i < operations.size(); i++) {
            Span op = operations.get(i);
            durations[i] = op.end - op.start;
            long overlap = index.overlap(op);
            totalOverlap = Math.addExact(totalOverlap, overlap);
            if (overlap > 0) withPause[affected++] = durations[i];
            else withoutPause[unaffected++] = durations[i];
        }
        return "{\"operations\":" + operations.size() + ",\"with_pause\":" + affected +
            ",\"pause_events\":" + pauses.size() + ",\"pause_wall_ns\":" + index.prefix[index.merged.size()] +
            ",\"operation_overlap_ns\":" + totalOverlap +
            ",\"operation_p95_ns\":" + p95(durations, durations.length) +
            ",\"with_pause_p95_ns\":" + p95(withPause, affected) +
            ",\"without_pause_p95_ns\":" + p95(withoutPause, unaffected) + "}";
    }

    static String analyze(Path recording, String operationName) throws IOException {
        var pauses = new ArrayList<Span>();
        var operations = new ArrayList<Span>();
        Instant origin = null;
        try (var file = new RecordingFile(recording)) {
            if (file.readEventTypes().stream().noneMatch(type -> type.getName().equals(operationName)))
                throw new IllegalArgumentException("Unknown operation event type: " + operationName);
            while (file.hasMoreEvents()) {
                var event = file.readEvent();
                String name = event.getEventType().getName();
                if (!name.equals("jdk.GCPhasePause") && !name.equals(operationName)) continue;
                if (origin == null) origin = event.getStartTime();
                long start = Duration.between(origin, event.getStartTime()).toNanos();
                long end = Duration.between(origin, event.getEndTime()).toNanos();
                (name.equals(operationName) ? operations : pauses).add(new Span(start, end));
            }
        }
        return summarize(operations, pauses);
    }

    public static void main(String[] args) {
        try {
            if (args.length != 2 || args[1].equals("jdk.GCPhasePause"))
                throw new IllegalArgumentException("Usage: PauseLens recording.jfr operation-event-name");
            System.out.println(analyze(Path.of(args[0]), args[1]));
        } catch (IOException | IllegalArgumentException error) {
            System.err.println(error.getMessage());
            System.exit(2);
        }
    }
}
