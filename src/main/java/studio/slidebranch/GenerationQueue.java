package studio.slidebranch;

import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

final class GenerationQueue implements AutoCloseable {
    private final Studio studio;
    private final java.util.concurrent.ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor();
    private final AtomicInteger running = new AtomicInteger();
    private boolean closed;

    GenerationQueue(Studio studio) {
        this.studio = studio;
    }

    synchronized void dispatch() throws Exception {
        if (closed) {
            return;
        }
        while (true) {
            int limit = studio.settings.generationConcurrency();
            if (limit > 0 && running.get() >= limit) {
                return;
            }
            var job = studio.claim("generation_jobs");
            if (job == null) {
                return;
            }
            running.incrementAndGet();
            executor.submit(() -> {
                try {
                    studio.runGeneration(job);
                } catch (Exception failure) {
                    failure.printStackTrace(System.err);
                } finally {
                    running.decrementAndGet();
                }
            });
        }
    }

    @Override
    public synchronized void close() throws InterruptedException {
        closed = true;
        executor.shutdownNow();
        executor.awaitTermination(10, TimeUnit.SECONDS);
    }
}
