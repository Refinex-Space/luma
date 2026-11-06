package demo;

import java.util.List;

/**
 * A person.
 */
public class Person {
    @lombok.Generated
    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(Person.class);
    // the name
    private final String name;
    private int age; // years
    private boolean active;
    private List<String> tags;

    public void greet() {
        log.info("hi {}", name); // inline comment
    }

    @lombok.Generated
    Person(final String name, final int age, final boolean active, final List<String> tags) {
        this.name = name;
        this.age = age;
        this.active = active;
        this.tags = tags;
    }


    @lombok.Generated
    public static class PersonBuilder {
        @lombok.Generated
        private String name;
        @lombok.Generated
        private int age;
        @lombok.Generated
        private boolean active;
        @lombok.Generated
        private java.util.ArrayList<String> tags;

        @lombok.Generated
        PersonBuilder() {
        }

        /**
         * @return {@code this}.
         */
        @lombok.Generated
        public Person.PersonBuilder name(final String name) {
            this.name = name;
            return this;
        }

        /**
         * @return {@code this}.
         */
        @lombok.Generated
        public Person.PersonBuilder age(final int age) {
            this.age = age;
            return this;
        }

        /**
         * @return {@code this}.
         */
        @lombok.Generated
        public Person.PersonBuilder active(final boolean active) {
            this.active = active;
            return this;
        }

        @lombok.Generated
        public Person.PersonBuilder tag(final String tag) {
            if (this.tags == null) this.tags = new java.util.ArrayList<String>();
            this.tags.add(tag);
            return this;
        }

        @lombok.Generated
        public Person.PersonBuilder tags(final java.util.Collection<? extends String> tags) {
            if (tags == null) {
                throw new NullPointerException("tags cannot be null");
            }
            if (this.tags == null) this.tags = new java.util.ArrayList<String>();
            this.tags.addAll(tags);
            return this;
        }

        @lombok.Generated
        public Person.PersonBuilder clearTags() {
            if (this.tags != null) this.tags.clear();
            return this;
        }

        @lombok.Generated
        public Person build() {
            java.util.List<String> tags;
            switch (this.tags == null ? 0 : this.tags.size()) {
            case 0: 
                tags = java.util.Collections.emptyList();
                break;
            case 1: 
                tags = java.util.Collections.singletonList(this.tags.get(0));
                break;
            default: 
                tags = java.util.Collections.unmodifiableList(new java.util.ArrayList<String>(this.tags));
            }
            return new Person(this.name, this.age, this.active, tags);
        }

        @Override
        @lombok.Generated
        public String toString() {
            return "Person.PersonBuilder(name=" + this.name + ", age=" + this.age + ", active=" + this.active + ", tags=" + this.tags + ")";
        }
    }

    @lombok.Generated
    public static Person.PersonBuilder builder() {
        return new Person.PersonBuilder();
    }

    @lombok.Generated
    public String getName() {
        return this.name;
    }

    @lombok.Generated
    public int getAge() {
        return this.age;
    }

    @lombok.Generated
    public boolean isActive() {
        return this.active;
    }

    @lombok.Generated
    public List<String> getTags() {
        return this.tags;
    }

    @lombok.Generated
    public void setAge(final int age) {
        this.age = age;
    }

    @lombok.Generated
    public void setActive(final boolean active) {
        this.active = active;
    }

    @lombok.Generated
    public void setTags(final List<String> tags) {
        this.tags = tags;
    }

    @Override
    @lombok.Generated
    public boolean equals(final Object o) {
        if (o == this) return true;
        if (!(o instanceof Person)) return false;
        final Person other = (Person) o;
        if (!other.canEqual((Object) this)) return false;
        if (this.getAge() != other.getAge()) return false;
        if (this.isActive() != other.isActive()) return false;
        final Object this$name = this.getName();
        final Object other$name = other.getName();
        if (this$name == null ? other$name != null : !this$name.equals(other$name)) return false;
        final Object this$tags = this.getTags();
        final Object other$tags = other.getTags();
        if (this$tags == null ? other$tags != null : !this$tags.equals(other$tags)) return false;
        return true;
    }

    @lombok.Generated
    protected boolean canEqual(final Object other) {
        return other instanceof Person;
    }

    @Override
    @lombok.Generated
    public int hashCode() {
        final int PRIME = 59;
        int result = 1;
        result = result * PRIME + this.getAge();
        result = result * PRIME + (this.isActive() ? 79 : 97);
        final Object $name = this.getName();
        result = result * PRIME + ($name == null ? 43 : $name.hashCode());
        final Object $tags = this.getTags();
        result = result * PRIME + ($tags == null ? 43 : $tags.hashCode());
        return result;
    }

    @Override
    @lombok.Generated
    public String toString() {
        return "Person(name=" + this.getName() + ", age=" + this.getAge() + ", active=" + this.isActive() + ", tags=" + this.getTags() + ")";
    }
}
