package com.acme.orders;

import java.math.BigDecimal;

/**
 * An order of a customer.
 */
public class Order {
    private Long id;
    private String customer;
    private BigDecimal total;

    @lombok.Generated
    public Long getId() {
        return this.id;
    }

    @lombok.Generated
    public String getCustomer() {
        return this.customer;
    }

    @lombok.Generated
    public BigDecimal getTotal() {
        return this.total;
    }

    @lombok.Generated
    public void setId(final Long id) {
        this.id = id;
    }

    @lombok.Generated
    public void setCustomer(final String customer) {
        this.customer = customer;
    }

    @lombok.Generated
    public void setTotal(final BigDecimal total) {
        this.total = total;
    }

    @Override
    @lombok.Generated
    public boolean equals(final Object o) {
        if (o == this) return true;
        if (!(o instanceof Order)) return false;
        final Order other = (Order) o;
        if (!other.canEqual((Object) this)) return false;
        final Object this$id = this.getId();
        final Object other$id = other.getId();
        if (this$id == null ? other$id != null : !this$id.equals(other$id)) return false;
        final Object this$customer = this.getCustomer();
        final Object other$customer = other.getCustomer();
        if (this$customer == null ? other$customer != null : !this$customer.equals(other$customer)) return false;
        final Object this$total = this.getTotal();
        final Object other$total = other.getTotal();
        if (this$total == null ? other$total != null : !this$total.equals(other$total)) return false;
        return true;
    }

    @lombok.Generated
    protected boolean canEqual(final Object other) {
        return other instanceof Order;
    }

    @Override
    @lombok.Generated
    public int hashCode() {
        final int PRIME = 59;
        int result = 1;
        final Object $id = this.getId();
        result = result * PRIME + ($id == null ? 43 : $id.hashCode());
        final Object $customer = this.getCustomer();
        result = result * PRIME + ($customer == null ? 43 : $customer.hashCode());
        final Object $total = this.getTotal();
        result = result * PRIME + ($total == null ? 43 : $total.hashCode());
        return result;
    }

    @Override
    @lombok.Generated
    public String toString() {
        return "Order(id=" + this.getId() + ", customer=" + this.getCustomer() + ", total=" + this.getTotal() + ")";
    }

    @lombok.Generated
    public Order() {
    }

    @lombok.Generated
    public Order(final Long id, final String customer, final BigDecimal total) {
        this.id = id;
        this.customer = customer;
        this.total = total;
    }
}
