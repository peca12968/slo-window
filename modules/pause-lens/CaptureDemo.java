import java.nio.file.Path;
import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import jdk.jfr.Event;
import jdk.jfr.Name;
import jdk.jfr.Recording;

public class CaptureDemo {
    @Name("demo.Request")
    static class Request extends Event {}
    @Name("demo.IdleRequest")
    static class IdleRequest extends Event {}

    static void recordShortRequest() throws InterruptedException {
        Request request = new Request();
        request.begin();
        Thread.sleep(5);
        request.commit();
    }

    public static void main(String[] args) throws Exception {
        try (Recording recording = new Recording()) {
            recording.enable(Request.class).withThreshold(Duration.ZERO);
            recording.enable(IdleRequest.class);
            new IdleRequest(); // Initialize its JFR metadata without committing an event.
            recording.enable("jdk.GCPhasePause").withThreshold(Duration.ZERO);
            recording.start();
            recordShortRequest();
            var ready = new CountDownLatch(2);
            var resume = new CountDownLatch(1);
            try (var executor = Executors.newFixedThreadPool(2)) {
                java.util.concurrent.Callable<Void> work = () -> {
                    Request request = new Request();
                    request.begin();
                    ready.countDown();
                    resume.await();
                    request.commit();
                    return null;
                };
                var first = executor.submit(work);
                var second = executor.submit(work);
                try {
                    ready.await();
                    System.gc();
                } finally {
                    resume.countDown();
                }
                first.get();
                second.get();
            }
            recordShortRequest();
            recording.stop();
            recording.dump(Path.of(args[0]));
        }
    }
}
