package fx;

public record Point<N extends Number>(N x, N y) {
    public Point { }
    public static Point<Integer> origin() { return new Point<>(0, 0); }
}
