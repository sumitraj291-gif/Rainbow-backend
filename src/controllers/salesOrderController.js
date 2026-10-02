const pool = require("../config/database");

/**
 * GET ALL SALES ORDERS
 */
const getSalesOrders = async (req, res) => {
    try {
        const [orders] = await pool.query(`
            SELECT
                so.id,
                so.order_number,
                so.customer_id,
                c.company_name AS customer_name,
                so.order_date,
                so.expected_delivery_date,
                so.priority,
                so.status,
                so.notes,
                so.created_at,

                COALESCE(SUM(soi.ordered_quantity), 0) AS total_quantity,
                COALESCE(SUM(soi.ordered_quantity * soi.unit_price), 0) AS total_amount,
                COUNT(soi.id) AS item_count

            FROM sales_orders so

            INNER JOIN customers c
                ON c.id = so.customer_id

            LEFT JOIN sales_order_items soi
                ON soi.sales_order_id = so.id

            GROUP BY
                so.id,
                so.order_number,
                so.customer_id,
                c.company_name,
                so.order_date,
                so.expected_delivery_date,
                so.priority,
                so.status,
                so.notes,
                so.created_at

            ORDER BY so.id DESC
        `);

        res.json({
            success: true,
            data: orders
        });

    } catch (error) {
        console.error("Get Sales Orders Error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to fetch sales orders",
            error: error.message
        });
    }
};


/**
 * GET SINGLE SALES ORDER
 */
const getSalesOrderById = async (req, res) => {
    const connection = await pool.getConnection();

    try {
        const { id } = req.params;

        const [orders] = await connection.query(`
            SELECT
                so.*,
                c.company_name AS customer_name
            FROM sales_orders so
            INNER JOIN customers c
                ON c.id = so.customer_id
            WHERE so.id = ?
        `, [id]);

        if (orders.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Sales order not found"
            });
        }

        const [items] = await connection.query(`
            SELECT
                soi.id,
                soi.sales_order_id,
                soi.product_id,
                p.product_code,
                p.product_name,
                soi.ordered_quantity,
                soi.unit_price,
                soi.delivery_date,
                soi.specification,
                (soi.ordered_quantity * soi.unit_price) AS line_total
            FROM sales_order_items soi
            INNER JOIN products p
                ON p.id = soi.product_id
            WHERE soi.sales_order_id = ?
            ORDER BY soi.id ASC
        `, [id]);

        res.json({
            success: true,
            data: {
                ...orders[0],
                items
            }
        });

    } catch (error) {
        console.error("Get Sales Order Error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to fetch sales order",
            error: error.message
        });

    } finally {
        connection.release();
    }
};


/**
 * GET OPTIONS
 * Customers + Active Products
 */
const getSalesOrderOptions = async (req, res) => {
    try {
        const [customers] = await pool.query(`
            SELECT
                id,
                customer_code,
                company_name
            FROM customers
            WHERE status = 'ACTIVE'
            ORDER BY company_name ASC
        `);

        const [products] = await pool.query(`
            SELECT
                p.id,
                p.product_code,
                p.product_name,
                p.selling_price,
                u.symbol AS unit_symbol
            FROM products p
            LEFT JOIN units u
                ON u.id = p.unit_id
            WHERE p.status = 'ACTIVE'
            ORDER BY p.product_name ASC
        `);

        res.json({
            success: true,
            data: {
                customers,
                products
            }
        });

    } catch (error) {
        console.error("Sales Order Options Error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to fetch sales order options",
            error: error.message
        });
    }
};


/**
 * CREATE SALES ORDER
 */
const createSalesOrder = async (req, res) => {
    const connection = await pool.getConnection();

    try {
        const {
            order_number,
            customer_id,
            order_date,
            expected_delivery_date,
            priority = "NORMAL",
            status = "DRAFT",
            notes,
            items
        } = req.body;

        if (!order_number) {
            return res.status(400).json({
                success: false,
                message: "Order number is required"
            });
        }

        if (!customer_id) {
            return res.status(400).json({
                success: false,
                message: "Customer is required"
            });
        }

        if (!order_date) {
            return res.status(400).json({
                success: false,
                message: "Order date is required"
            });
        }

        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({
                success: false,
                message: "At least one product is required"
            });
        }

        await connection.beginTransaction();

        // Check duplicate order number
        const [existingOrder] = await connection.query(
            `SELECT id FROM sales_orders WHERE order_number = ? LIMIT 1`,
            [order_number]
        );

        if (existingOrder.length > 0) {
            await connection.rollback();

            return res.status(409).json({
                success: false,
                message: "Sales order number already exists"
            });
        }

        // Check customer
        const [customer] = await connection.query(
            `SELECT id FROM customers WHERE id = ? AND status = 'ACTIVE' LIMIT 1`,
            [customer_id]
        );

        if (customer.length === 0) {
            await connection.rollback();

            return res.status(400).json({
                success: false,
                message: "Selected customer is invalid or inactive"
            });
        }

        // Create sales order
        const [orderResult] = await connection.query(`
            INSERT INTO sales_orders (
                order_number,
                customer_id,
                order_date,
                expected_delivery_date,
                priority,
                status,
                notes
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
            order_number,
            customer_id,
            order_date,
            expected_delivery_date || null,
            priority,
            status,
            notes || null
        ]);

        const salesOrderId = orderResult.insertId;

        // Insert items
        for (const item of items) {

            if (!item.product_id) {
                throw new Error("Product is required for every order item");
            }

            const ordQty = item.ordered_quantity || item.ordered_qty || item.quantity;

            if (!ordQty || Number(ordQty) <= 0) {
                throw new Error("Ordered quantity must be greater than zero");
            }

            const [product] = await connection.query(
                `
                SELECT id, selling_price
                FROM products
                WHERE id = ?
                AND status = 'ACTIVE'
                LIMIT 1
                `,
                [item.product_id]
            );

            if (product.length === 0) {
                throw new Error(
                    `Product ID ${item.product_id} is invalid or inactive`
                );
            }

            const unitPrice =
                item.unit_price !== undefined &&
                item.unit_price !== null &&
                item.unit_price !== ""
                    ? Number(item.unit_price)
                    : Number(product[0].selling_price || 0);

            await connection.query(`
                INSERT INTO sales_order_items (
                    sales_order_id,
                    product_id,
                    ordered_quantity,
                    unit_price,
                    delivery_date,
                    specification
                )
                VALUES (?, ?, ?, ?, ?, ?)
            `, [
                salesOrderId,
                item.product_id,
                ordQty,
                unitPrice,
                item.delivery_date || expected_delivery_date || null,
                item.specification || null
            ]);
        }

        await connection.commit();

        res.status(201).json({
            success: true,
            message: "Sales order created successfully",
            data: {
                id: salesOrderId,
                order_number
            }
        });

    } catch (error) {
        await connection.rollback();

        console.error("Create Sales Order Error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to create sales order",
            error: error.message
        });

    } finally {
        connection.release();
    }
};


/**
 * UPDATE SALES ORDER
 */
const updateSalesOrder = async (req, res) => {
    const connection = await pool.getConnection();

    try {
        const { id } = req.params;

        const {
            order_number,
            customer_id,
            order_date,
            expected_delivery_date,
            priority,
            status,
            notes,
            items
        } = req.body;

        if (!order_number || !customer_id || !order_date) {
            return res.status(400).json({
                success: false,
                message: "Order number, customer and order date are required"
            });
        }

        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({
                success: false,
                message: "At least one product is required"
            });
        }

        await connection.beginTransaction();

        const [existing] = await connection.query(
            `SELECT * FROM sales_orders WHERE id = ? FOR UPDATE`,
            [id]
        );

        if (existing.length === 0) {
            await connection.rollback();

            return res.status(404).json({
                success: false,
                message: "Sales order not found"
            });
        }

        // Do not edit completed/cancelled orders
        if (
            existing[0].status === "COMPLETED" ||
            existing[0].status === "CANCELLED"
        ) {
            await connection.rollback();

            return res.status(400).json({
                success: false,
                message: `Cannot edit a ${existing[0].status.toLowerCase()} sales order`
            });
        }

        // Check duplicate order number
        const [duplicate] = await connection.query(
            `
            SELECT id
            FROM sales_orders
            WHERE order_number = ?
            AND id <> ?
            LIMIT 1
            `,
            [order_number, id]
        );

        if (duplicate.length > 0) {
            await connection.rollback();

            return res.status(409).json({
                success: false,
                message: "Sales order number already exists"
            });
        }

        await connection.query(`
            UPDATE sales_orders
            SET
                order_number = ?,
                customer_id = ?,
                order_date = ?,
                expected_delivery_date = ?,
                priority = ?,
                status = ?,
                notes = ?
            WHERE id = ?
        `, [
            order_number,
            customer_id,
            order_date,
            expected_delivery_date || null,
            priority || "NORMAL",
            status || "DRAFT",
            notes || null,
            id
        ]);

        // Replace order items
        await connection.query(
            `DELETE FROM sales_order_items WHERE sales_order_id = ?`,
            [id]
        );

        for (const item of items) {

            if (!item.product_id) {
                throw new Error("Product is required for every order item");
            }

            if (!item.ordered_quantity || Number(item.ordered_quantity) <= 0) {
                throw new Error("Ordered quantity must be greater than zero");
            }

            const [product] = await connection.query(
                `
                SELECT id, selling_price
                FROM products
                WHERE id = ?
                AND status = 'ACTIVE'
                LIMIT 1
                `,
                [item.product_id]
            );

            if (product.length === 0) {
                throw new Error(
                    `Product ID ${item.product_id} is invalid or inactive`
                );
            }

            const unitPrice =
                item.unit_price !== undefined &&
                item.unit_price !== null &&
                item.unit_price !== ""
                    ? Number(item.unit_price)
                    : Number(product[0].selling_price || 0);

            await connection.query(`
                INSERT INTO sales_order_items (
                    sales_order_id,
                    product_id,
                    ordered_quantity,
                    unit_price,
                    delivery_date,
                    specification
                )
                VALUES (?, ?, ?, ?, ?, ?)
            `, [
                id,
                item.product_id,
                item.ordered_quantity,
                unitPrice,
                item.delivery_date || expected_delivery_date || null,
                item.specification || null
            ]);
        }

        await connection.commit();

        res.json({
            success: true,
            message: "Sales order updated successfully"
        });

    } catch (error) {
        await connection.rollback();

        console.error("Update Sales Order Error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to update sales order",
            error: error.message
        });

    } finally {
        connection.release();
    }
};


/**
 * DELETE SALES ORDER
 */
const deleteSalesOrder = async (req, res) => {
    const connection = await pool.getConnection();

    try {
        const { id } = req.params;

        await connection.beginTransaction();

        const [orders] = await connection.query(
            `SELECT * FROM sales_orders WHERE id = ? FOR UPDATE`,
            [id]
        );

        if (orders.length === 0) {
            await connection.rollback();

            return res.status(404).json({
                success: false,
                message: "Sales order not found"
            });
        }

        const [productionOrders] = await connection.query(
            `
            SELECT id
            FROM production_orders
            WHERE sales_order_id = ?
            LIMIT 1
            `,
            [id]
        );

        if (productionOrders.length > 0) {
            await connection.rollback();

            return res.status(400).json({
                success: false,
                message: "Sales order cannot be deleted because a production order already exists"
            });
        }

        await connection.query(
            `DELETE FROM sales_order_items WHERE sales_order_id = ?`,
            [id]
        );

        await connection.query(
            `DELETE FROM sales_orders WHERE id = ?`,
            [id]
        );

        await connection.commit();

        res.json({
            success: true,
            message: "Sales order deleted successfully"
        });

    } catch (error) {
        await connection.rollback();

        console.error("Delete Sales Order Error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to delete sales order",
            error: error.message
        });

    } finally {
        connection.release();
    }
};


/**
 * SEED SAMPLE SALES ORDERS
 */
const seedSalesOrders = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [customers] = await connection.query(`SELECT id, company_name FROM customers WHERE status = 'ACTIVE' LIMIT 5`);
        const [products] = await connection.query(`SELECT id, product_code, product_name, selling_price FROM products WHERE status = 'ACTIVE' LIMIT 6`);

        if (customers.length === 0 || products.length === 0) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "Please ensure active customers and products exist before seeding sales orders."
            });
        }

        const today = new Date().toISOString().split("T")[0];
        const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0];
        const twoWeeks = new Date(Date.now() + 14 * 86400000).toISOString().split("T")[0];

        const sampleOrders = [
            {
                order_number: "SO-2026-0001",
                customer_id: customers[0].id,
                order_date: today,
                expected_delivery_date: nextWeek,
                priority: "HIGH",
                status: "CONFIRMED",
                notes: "Priority delivery for showroom launch. Standard export carton packaging required.",
                items: [
                    { product_id: products[0].id, ordered_quantity: 600, unit_price: Number(products[0].selling_price) || 125, delivery_date: nextWeek, specification: "Standard Blue 38x60cm" },
                    { product_id: products[1 % products.length].id, ordered_quantity: 400, unit_price: Number(products[1 % products.length].selling_price) || 125, delivery_date: nextWeek, specification: "Brown Spike 38x60cm" }
                ]
            },
            {
                order_number: "SO-2026-0002",
                customer_id: customers[1 % customers.length].id,
                order_date: today,
                expected_delivery_date: twoWeeks,
                priority: "NORMAL",
                status: "IN_PRODUCTION",
                notes: "Wholesale bulk consignment batch 1. Inspect backing adhesion before dispatch.",
                items: [
                    { product_id: products[2 % products.length].id, ordered_quantity: 1200, unit_price: Number(products[2 % products.length].selling_price) || 125, delivery_date: twoWeeks, specification: "Royal Grey 38x60cm" },
                    { product_id: products[3 % products.length].id, ordered_quantity: 800, unit_price: Number(products[3 % products.length].selling_price) || 125, delivery_date: twoWeeks, specification: "Spike Red 38x60cm" }
                ]
            },
            {
                order_number: "SO-2026-0003",
                customer_id: customers[2 % customers.length].id,
                order_date: today,
                expected_delivery_date: nextWeek,
                priority: "URGENT",
                status: "DRAFT",
                notes: "Urgent festival replenishment requirement. Advance received.",
                items: [
                    { product_id: products[4 % products.length].id, ordered_quantity: 500, unit_price: Number(products[4 % products.length].selling_price) || 125, delivery_date: nextWeek, specification: "Spike Green 38x60cm" }
                ]
            }
        ];

        let seededCount = 0;
        for (const order of sampleOrders) {
            const [existing] = await connection.query(
                `SELECT id FROM sales_orders WHERE order_number = ? LIMIT 1`,
                [order.order_number]
            );

            if (existing.length === 0) {
                const [orderResult] = await connection.query(`
                    INSERT INTO sales_orders (
                        order_number,
                        customer_id,
                        order_date,
                        expected_delivery_date,
                        priority,
                        status,
                        notes
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                `, [
                    order.order_number,
                    order.customer_id,
                    order.order_date,
                    order.expected_delivery_date,
                    order.priority,
                    order.status,
                    order.notes
                ]);

                const salesOrderId = orderResult.insertId;

                for (const item of order.items) {
                    await connection.query(`
                        INSERT INTO sales_order_items (
                            sales_order_id,
                            product_id,
                            ordered_quantity,
                            unit_price,
                            delivery_date,
                            specification
                        ) VALUES (?, ?, ?, ?, ?, ?)
                    `, [
                        salesOrderId,
                        item.product_id,
                        item.ordered_quantity,
                        item.unit_price,
                        item.delivery_date,
                        item.specification
                    ]);
                }
                seededCount++;
            }
        }

        await connection.commit();

        res.json({
            success: true,
            message: `Successfully seeded ${seededCount} sample sales orders!`,
            count: seededCount
        });

    } catch (error) {
        await connection.rollback();
        console.error("Seed Sales Orders Error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to seed sales orders",
            error: error.message
        });
    } finally {
        connection.release();
    }
};

module.exports = {
    getSalesOrders,
    getSalesOrderById,
    getSalesOrderOptions,
    createSalesOrder,
    updateSalesOrder,
    deleteSalesOrder,
    seedSalesOrders
};