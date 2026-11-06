package com.acme.orders;

import java.math.BigDecimal;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

/** An order of a customer. */
@Data
@NoArgsConstructor
@AllArgsConstructor
public class Order {
    private Long id;
    private String customer;
    private BigDecimal total;
}
