import java.util.ArrayList;
import java.util.List;
import java.util.Random;

public class PauseIndexTest {
    public static void main(String[] args) {
        var random = new Random(12968);
        int checked = 0;
        for (int trial = 0; trial < 240; trial++) {
            var pauses = new ArrayList<PauseLens.Span>();
            for (int i = random.nextInt(12); i > 0; i--) {
                int start = random.nextInt(45) - 20;
                pauses.add(new PauseLens.Span(start, start + random.nextInt(10)));
            }
            var index = new PauseLens.PauseIndex(pauses);
            for (int i = 0; i < 25; i++) {
                int a = random.nextInt(55) - 25, b = a + random.nextInt(15);
                long expected = 0;
                for (int tick = a; tick < b; tick++) {
                    for (var pause : pauses) {
                        if (pause.start() <= tick && tick < pause.end()) {
                            expected++;
                            break;
                        }
                    }
                }
                if (index.overlap(new PauseLens.Span(a, b)) != expected)
                    throw new AssertionError("Incorrect overlap at trial " + trial);
                checked++;
            }
        }
        var left = new PauseLens.Span(1, 10);
        var right = new PauseLens.Span(5, 14);
        String fixed = PauseLens.summarize(List.of(left, right), List.of(new PauseLens.Span(5, 8)));
        if (!fixed.contains("\"operation_overlap_ns\":6,") || !fixed.contains("\"pause_wall_ns\":3,")
                || !fixed.contains("\"without_pause_p95_ns\":null"))
            throw new AssertionError(fixed);
        System.out.println("Verified " + checked + " interval queries");
    }
}
