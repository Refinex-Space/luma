package demo;

import java.util.List;
import lombok.Builder;
import lombok.Data;
import lombok.Singular;
import lombok.extern.slf4j.Slf4j;

/** A person. */
@Slf4j
@Data
@Builder
public class Person {
    // the name
    private final String name;
    private int age;   // years
    private boolean active;
    @Singular
    private List<String> tags;

    public void greet() {
        log.info("hi {}", name); // inline comment
    }
}
