package demo;

public final class Util {
    static int counter;

    public static int twice(int a) {
        return a * 2;
    }

    @lombok.Generated
    private Util() {
        throw new UnsupportedOperationException("This is a utility class and cannot be instantiated");
    }
}
