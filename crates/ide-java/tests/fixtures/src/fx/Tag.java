package fx;

import java.lang.annotation.*;

@Retention(RetentionPolicy.RUNTIME)
@Target({ElementType.TYPE, ElementType.METHOD})
public @interface Tag {
    String value() default "";
    int priority() default 1;
    Color color();
    Class<?>[] types() default {};
}
