package studio.slidebranch;

final class Problem extends RuntimeException {
    final int status;

    Problem(int status, String message) {
        super(message);
        this.status = status;
    }
}
