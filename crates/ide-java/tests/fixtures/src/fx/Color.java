package fx;

public enum Color {
    RED("r"), GREEN("g");
    private final String code;
    Color(String code) { this.code = code; }
    public String code() { return code; }
}
