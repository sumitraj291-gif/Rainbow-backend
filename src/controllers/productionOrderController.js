const pool = require("../config/database");


/*
=========================================================
GET ALL PRODUCTION ORDERS
=========================================================
*/
const getProductionOrders = async (req, res) => {
    try {

        const [rows] = await pool.query(`
            SELECT
                po.id,
                po.production_order_number,
                po.sales_order_id,
                so.order_number AS sales_order_number,
                po.product_id,

                p.product_code,
                p.product_name,

                po.planned_quantity,
                po.target_quantity,

                COALESCE(
                    (
                        SELECT SUM(pe.input_quantity)
                        FROM production_entries pe
                        WHERE pe.production_order_id = po.id
                    ),
                    0
                ) AS actual_input_quantity,

                COALESCE(
                    (
                        SELECT SUM(pe.good_quantity)
                        FROM production_entries pe
                        WHERE pe.production_order_id = po.id
                    ),
                    0
                ) AS good_quantity,

                COALESCE(
                    (
                        SELECT SUM(pe.rejected_quantity)
                        FROM production_entries pe
                        WHERE pe.production_order_id = po.id
                    ),
                    0
                ) AS rejected_quantity,

                COALESCE(
                    (
                        SELECT SUM(pe.wastage_quantity)
                        FROM production_entries pe
                        WHERE pe.production_order_id = po.id
                    ),
                    0
                ) AS wastage_quantity,

                COALESCE(
                    (
                        SELECT SUM(pe.downtime_minutes)
                        FROM production_entries pe
                        WHERE pe.production_order_id = po.id
                    ),
                    0
                ) AS downtime_minutes,

                COALESCE(
                    (
                        SELECT COUNT(*)
                        FROM production_entries pe
                        WHERE pe.production_order_id = po.id
                    ),
                    0
                ) AS production_entry_count,

                po.production_date,
                po.expected_completion_date,

                po.priority,
                po.shift,
                po.supervisor_id,
                po.status,
                po.remarks,

                po.created_at,
                po.updated_at

            FROM production_orders po

            LEFT JOIN products p
                ON p.id = po.product_id

            LEFT JOIN sales_orders so
                ON so.id = po.sales_order_id

            ORDER BY po.created_at DESC
        `);


        const formattedRows = rows.map((row) => {

            const planned =
                Number(row.planned_quantity || 0);

            const target =
                Number(row.target_quantity || 0);

            const input =
                Number(row.actual_input_quantity || 0);

            const good =
                Number(row.good_quantity || 0);

            const rejected =
                Number(row.rejected_quantity || 0);

            const wastage =
                Number(row.wastage_quantity || 0);

            const totalOutput =
                good + rejected + wastage;

            const remaining =
                Math.max(
                    planned - totalOutput,
                    0
                );

            const productionPercentage =
                planned > 0
                    ? Math.min(
                        (totalOutput / planned) * 100,
                        100
                    )
                    : 0;

            const yieldPercentage =
                totalOutput > 0
                    ? (good / totalOutput) * 100
                    : 0;


            return {
                ...row,

                planned_quantity:
                    planned,

                target_quantity:
                    target,

                actual_input_quantity:
                    input,

                good_quantity:
                    good,

                rejected_quantity:
                    rejected,

                wastage_quantity:
                    wastage,

                downtime_minutes:
                    Number(
                        row.downtime_minutes || 0
                    ),

                production_entry_count:
                    Number(
                        row.production_entry_count || 0
                    ),

                total_output:
                    totalOutput,

                remaining_quantity:
                    remaining,

                production_percentage:
                    Number(
                        productionPercentage.toFixed(2)
                    ),

                yield_percentage:
                    Number(
                        yieldPercentage.toFixed(2)
                    )
            };
        });


        res.json({
            success: true,
            data: formattedRows
        });

    } catch (error) {

        console.error(
            "Get Production Orders Error:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Unable to load production orders",
            error: error.message
        });
    }
};


/*
=========================================================
GET PRODUCTION ORDER BY ID
=========================================================
*/
const getProductionOrderById = async (req, res) => {
    try {
        const { id } = req.params;

        const [rows] = await pool.query(`
            SELECT
                po.*,

                so.order_number AS sales_order_number,

                p.product_code,
                p.product_name,

                /* -----------------------------------------
                   PROCESS EXECUTION SUMMARY
                ----------------------------------------- */

                COALESCE(
                    GREATEST(
                        (SELECT COALESCE(SUM(pe.input_quantity), 0) FROM production_entries pe WHERE pe.production_order_id = po.id),
                        (SELECT COALESCE(SUM(pop.input_quantity), 0) FROM production_order_processes pop WHERE pop.production_order_id = po.id)
                    ),
                    0
                ) AS actual_input_quantity,

                COALESCE(
                    GREATEST(
                        (SELECT COALESCE(SUM(pe.good_quantity), 0) FROM production_entries pe WHERE pe.production_order_id = po.id),
                        (SELECT COALESCE(SUM(pop.good_quantity), 0) FROM production_order_processes pop WHERE pop.production_order_id = po.id)
                    ),
                    0
                ) AS good_quantity,

                COALESCE(
                    GREATEST(
                        (SELECT COALESCE(SUM(pe.rejected_quantity), 0) FROM production_entries pe WHERE pe.production_order_id = po.id),
                        (SELECT COALESCE(SUM(pop.rejected_quantity), 0) FROM production_order_processes pop WHERE pop.production_order_id = po.id)
                    ),
                    0
                ) AS rejected_quantity,

                COALESCE(
                    GREATEST(
                        (SELECT COALESCE(SUM(pe.wastage_quantity), 0) FROM production_entries pe WHERE pe.production_order_id = po.id),
                        (SELECT COALESCE(SUM(pop.wastage_quantity), 0) FROM production_order_processes pop WHERE pop.production_order_id = po.id)
                    ),
                    0
                ) AS wastage_quantity,

                /* -----------------------------------------
                   PRODUCTION ENTRY SUMMARY
                   Kept for compatibility / audit
                ----------------------------------------- */

                COALESCE(
                    (
                        SELECT SUM(pe.downtime_minutes)
                        FROM production_entries pe
                        WHERE pe.production_order_id = po.id
                    ),
                    0
                ) AS downtime_minutes,

                COALESCE(
                    (
                        SELECT COUNT(*)
                        FROM production_entries pe
                        WHERE pe.production_order_id = po.id
                    ),
                    0
                ) AS production_entry_count

            FROM production_orders po

            LEFT JOIN products p
                ON p.id = po.product_id

            LEFT JOIN sales_orders so
                ON so.id = po.sales_order_id

            WHERE po.id = ?

            LIMIT 1
        `, [id]);

        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Production order not found"
            });
        }

        const order = rows[0];

        /* -----------------------------------------
           CONVERT NUMERIC VALUES
        ----------------------------------------- */

        const plannedQuantity = Number(order.planned_quantity || 0);
        const actualInput = Number(order.actual_input_quantity || 0);
        const goodQuantity = Number(order.good_quantity || 0);
        const rejectedQuantity = Number(order.rejected_quantity || 0);
        const wastageQuantity = Number(order.wastage_quantity || 0);

        /* -----------------------------------------
           CALCULATE OUTPUT
        ----------------------------------------- */

        const totalOutput =
            goodQuantity +
            rejectedQuantity;

        const remainingQuantity =
            Math.max(plannedQuantity - goodQuantity, 0);

        const productionPercentage =
            plannedQuantity > 0
                ? (goodQuantity / plannedQuantity) * 100
                : 0;

        const yieldPercentage =
            actualInput > 0
                ? (goodQuantity / actualInput) * 100
                : 0;

        /* -----------------------------------------
           FINAL RESPONSE
        ----------------------------------------- */

        res.json({
            success: true,

            data: {
                ...order,

                actual_input_quantity: actualInput,
                good_quantity: goodQuantity,
                rejected_quantity: rejectedQuantity,
                wastage_quantity: wastageQuantity,

                total_output: totalOutput,
                remaining_quantity: remainingQuantity,

                production_percentage:
                    Number(productionPercentage.toFixed(2)),

                yield_percentage:
                    Number(yieldPercentage.toFixed(2))
            }
        });

    } catch (error) {

        console.error(
            "Get Production Order Error:",
            error
        );

        res.status(500).json({
            success: false,
            message: "Unable to load production order",
            error: error.message
        });
    }
};


/*
=========================================================
GET PRODUCTION ORDER OPTIONS
=========================================================

Used by ProductionOrders.jsx

Returns:
- Sales Orders
- Products
- Supervisors

Supervisor list is temporarily empty because
employee_name does not exist in the current
employees table.
=========================================================
*/
const getProductionOrderOptions = async (req, res) => {

    try {

        /*
        ---------------------------------------------
        SALES ORDERS
        ---------------------------------------------
        */

        const [salesOrders] = await pool.query(`
            SELECT
                so.id,
                so.order_number,
                c.company_name AS customer_name

            FROM sales_orders so

            LEFT JOIN customers c
                ON c.id = so.customer_id

            WHERE so.status IN (
                'CONFIRMED',
                'PARTIAL'
            )

            ORDER BY
                so.order_date DESC,
                so.id DESC
        `);


        /*
        ---------------------------------------------
        PRODUCTS
        ---------------------------------------------
        */

        const [products] = await pool.query(`
            SELECT
                id,
                product_code,
                product_name,
                selling_price

            FROM products

            WHERE status = 'ACTIVE'

            ORDER BY
                product_name ASC
        `);


        /*
        ---------------------------------------------
        SUPERVISORS / OPERATORS
        ---------------------------------------------
        */
        const [supervisors] = await pool.query(`
            SELECT
                id,
                employee_code,
                name AS employee_name,
                name,
                department,
                designation
            FROM employees
            WHERE status = 'ACTIVE'
            ORDER BY name ASC
        `);


        res.json({

            success: true,

            data: {
                salesOrders,
                products,
                supervisors
            }

        });

    } catch (error) {

        console.error(
            "Get Production Order Options Error:",
            error
        );

        res.status(500).json({

            success: false,

            message:
                "Unable to load production order options",

            error:
                error.message

        });
    }
};


/*
=========================================================
CREATE PRODUCTION ORDER
=========================================================
*/
const createProductionOrder = async (req, res) => {

    try {

        const {
            production_order_number,
            sales_order_id,
            product_id,
            planned_quantity,
            target_quantity,
            production_date,
            expected_completion_date,
            priority,
            shift,
            supervisor_id,
            status,
            remarks
        } = req.body;


        /*
        ---------------------------------------------
        VALIDATION
        ---------------------------------------------
        */

        if (!production_order_number) {

            return res.status(400).json({
                success: false,
                message:
                    "Production order number is required"
            });

        }


        if (!product_id) {

            return res.status(400).json({
                success: false,
                message:
                    "Product is required"
            });

        }


        const plannedQty = (planned_quantity !== undefined && planned_quantity !== null && planned_quantity !== "")
            ? planned_quantity
            : req.body.planned_qty;

        const targetQty = (target_quantity !== undefined && target_quantity !== null && target_quantity !== "")
            ? target_quantity
            : (req.body.target_qty || plannedQty);

        if (
            plannedQty === undefined ||
            plannedQty === null ||
            Number(plannedQty) <= 0
        ) {

            return res.status(400).json({
                success: false,
                message:
                    "Planned quantity must be greater than zero"
            });

        }


        /*
        ---------------------------------------------
        CHECK PRODUCT
        ---------------------------------------------
        */

        const [product] = await pool.query(`
            SELECT
                id

            FROM products

            WHERE id = ?
              AND status = 'ACTIVE'

            LIMIT 1
        `, [product_id]);


        if (product.length === 0) {

            return res.status(400).json({
                success: false,
                message:
                    "Selected product does not exist or is inactive"
            });

        }


        /*
        ---------------------------------------------
        CHECK SALES ORDER
        ---------------------------------------------
        */

        if (sales_order_id) {

            const [salesOrder] = await pool.query(`
                SELECT
                    id

                FROM sales_orders

                WHERE id = ?

                LIMIT 1
            `, [sales_order_id]);


            if (salesOrder.length === 0) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Selected sales order does not exist"
                });

            }

        }


        /*
        ---------------------------------------------
        CHECK DUPLICATE ORDER NUMBER
        ---------------------------------------------
        */

        const [existingOrder] =
            await pool.query(`
                SELECT
                    id

                FROM production_orders

                WHERE production_order_number = ?

                LIMIT 1
            `, [
                production_order_number
            ]);


        if (existingOrder.length > 0) {

            return res.status(409).json({
                success: false,
                message:
                    "Production order number already exists"
            });

        }


        /*
        ---------------------------------------------
        INSERT
        ---------------------------------------------
        */

        const [result] = await pool.query(`
            INSERT INTO production_orders
            (
                production_order_number,
                sales_order_id,
                product_id,
                planned_quantity,
                target_quantity,
                production_date,
                expected_completion_date,
                priority,
                shift,
                supervisor_id,
                status,
                remarks
            )

            VALUES (
                ?,
                ?,
                ?,
                ?,
                ?,
                ?,
                ?,
                ?,
                ?,
                ?,
                ?,
                ?
            )
        `, [

            production_order_number,

            sales_order_id ||
                null,

            product_id,

            plannedQty,

            targetQty,

            production_date ||
                null,

            expected_completion_date ||
                null,

            priority ||
                "NORMAL",

            shift ||
                "DAY",

            supervisor_id ||
                null,

            status ||
                "PLANNED",

            remarks ||
                null
        ]);

        const newOrderId = result.insertId;

        // Auto-generate production order processes from product routing
        try {
            const [routing] = await pool.query(`
                SELECT id, sequence_no, process_id, machine_id, standard_output_per_hour
                FROM product_processes
                WHERE product_id = ?
                ORDER BY sequence_no ASC
            `, [product_id]);

            if (routing.length > 0) {
                for (const route of routing) {
                    await pool.query(`
                        INSERT INTO production_order_processes
                        (
                            production_order_id,
                            product_process_id,
                            sequence_no,
                            process_status,
                            machine_id,
                            planned_quantity
                        )
                        VALUES (?, ?, ?, 'PENDING', ?, ?)
                    `, [
                        newOrderId,
                        route.id,
                        route.sequence_no,
                        route.machine_id,
                        plannedQty
                    ]);
                }
            }
        } catch (procErr) {
            console.error("Auto-generate process flow error:", procErr);
        }

        res.status(201).json({
            success: true,
            message: "Production order created successfully",
            data: {
                id: newOrderId,
                production_order_number
            }
        });


    } catch (error) {

        console.error(
            "Create Production Order Error:",
            error
        );

        res.status(500).json({

            success: false,

            message:
                "Unable to create production order",

            error:
                error.message

        });
    }
};


/*
=========================================================
UPDATE PRODUCTION ORDER
=========================================================
*/
const updateProductionOrder = async (req, res) => {

    try {

        const { id } = req.params;


        const {
            production_order_number,
            sales_order_id,
            product_id,
            planned_quantity,
            target_quantity,
            production_date,
            expected_completion_date,
            priority,
            shift,
            supervisor_id,
            status,
            remarks
        } = req.body;


        /*
        ---------------------------------------------
        CHECK EXISTING ORDER
        ---------------------------------------------
        */

        const [existing] =
            await pool.query(`
                SELECT
                    id

                FROM production_orders

                WHERE id = ?

                LIMIT 1
            `, [id]);


        if (existing.length === 0) {

            return res.status(404).json({

                success: false,

                message:
                    "Production order not found"

            });

        }


        /*
        ---------------------------------------------
        VALIDATION
        ---------------------------------------------
        */

        if (
            !production_order_number ||
            !product_id
        ) {

            return res.status(400).json({

                success: false,

                message:
                    "Production order number and product are required"

            });

        }


        if (
            planned_quantity === undefined ||
            planned_quantity === null ||
            Number(planned_quantity) <= 0
        ) {

            return res.status(400).json({

                success: false,

                message:
                    "Planned quantity must be greater than zero"

            });

        }


        /*
        ---------------------------------------------
        CHECK PRODUCT
        ---------------------------------------------
        */

        const [product] =
            await pool.query(`
                SELECT
                    id

                FROM products

                WHERE id = ?
                  AND status = 'ACTIVE'

                LIMIT 1
            `, [product_id]);


        if (product.length === 0) {

            return res.status(400).json({

                success: false,

                message:
                    "Selected product does not exist or is inactive"

            });

        }


        /*
        ---------------------------------------------
        CHECK SALES ORDER
        ---------------------------------------------
        */

        if (sales_order_id) {

            const [salesOrder] =
                await pool.query(`
                    SELECT
                        id

                    FROM sales_orders

                    WHERE id = ?

                    LIMIT 1
                `, [sales_order_id]);


            if (salesOrder.length === 0) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Selected sales order does not exist"

                });

            }

        }


        /*
        ---------------------------------------------
        DUPLICATE NUMBER CHECK
        ---------------------------------------------
        */

        const [duplicate] =
            await pool.query(`
                SELECT
                    id

                FROM production_orders

                WHERE production_order_number = ?

                  AND id != ?

                LIMIT 1
            `, [
                production_order_number,
                id
            ]);


        if (duplicate.length > 0) {

            return res.status(409).json({

                success: false,

                message:
                    "Production order number already exists"

            });

        }


        /*
        ---------------------------------------------
        UPDATE
        ---------------------------------------------
        */

        await pool.query(`
            UPDATE production_orders

            SET
                production_order_number = ?,
                sales_order_id = ?,
                product_id = ?,
                planned_quantity = ?,
                target_quantity = ?,
                production_date = ?,
                expected_completion_date = ?,
                priority = ?,
                shift = ?,
                supervisor_id = ?,
                status = ?,
                remarks = ?

            WHERE id = ?
        `, [

            production_order_number,

            sales_order_id ||
                null,

            product_id,

            planned_quantity,

            target_quantity ||
                planned_quantity,

            production_date ||
                null,

            expected_completion_date ||
                null,

            priority ||
                "NORMAL",

            shift ||
                "DAY",

            supervisor_id ||
                null,

            status ||
                "PLANNED",

            remarks ||
                null,

            id

        ]);


        res.json({

            success: true,

            message:
                "Production order updated successfully"

        });

    } catch (error) {

        console.error(
            "Update Production Order Error:",
            error
        );

        res.status(500).json({

            success: false,

            message:
                "Unable to update production order",

            error:
                error.message

        });
    }
};


/*
=========================================================
DELETE PRODUCTION ORDER
=========================================================
*/
const deleteProductionOrder = async (req, res) => {

    try {

        const { id } = req.params;


        /*
        ---------------------------------------------
        CHECK PRODUCTION ENTRIES
        ---------------------------------------------
        */

        const [entries] =
            await pool.query(`
                SELECT
                    COUNT(*) AS total

                FROM production_entries

                WHERE production_order_id = ?
            `, [id]);


        if (
            Number(entries[0].total) > 0
        ) {

            return res.status(400).json({

                success: false,

                message:
                    "This production order cannot be deleted because production entries already exist"

            });

        }


        /*
        ---------------------------------------------
        DELETE
        ---------------------------------------------
        */

        const [result] =
            await pool.query(`
                DELETE FROM production_orders

                WHERE id = ?
            `, [id]);


        if (
            result.affectedRows === 0
        ) {

            return res.status(404).json({

                success: false,

                message:
                    "Production order not found"

            });

        }


        res.json({

            success: true,

            message:
                "Production order deleted successfully"

        });

    } catch (error) {

        console.error(
            "Delete Production Order Error:",
            error
        );

        res.status(500).json({

            success: false,

            message:
                "Unable to delete production order",

            error:
                error.message

        });
    }
};


/*
=========================================================
SEED PRODUCTION ORDERS
=========================================================
*/
const seedProductionOrders = async (req, res) => {
    try {
        const [salesOrders] = await pool.query(`
            SELECT so.id, so.order_number, soi.product_id, soi.ordered_quantity 
            FROM sales_orders so 
            JOIN sales_order_items soi ON soi.sales_order_id = so.id 
            ORDER BY so.id ASC
        `);

        const [supervisors] = await pool.query(`
            SELECT id FROM employees WHERE status = 'ACTIVE' LIMIT 3
        `);

        if (salesOrders.length === 0) {
            return res.status(400).json({
                success: false,
                message: "No sales orders found. Please seed or create sales orders first."
            });
        }

        const supervisorId = supervisors.length > 0 ? supervisors[0].id : null;
        const today = new Date().toISOString().split("T")[0];
        const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0];

        const sampleProductionOrders = [
            {
                production_order_number: "PO-2026-0001",
                sales_order_id: salesOrders[0].id,
                product_id: salesOrders[0].product_id,
                planned_quantity: salesOrders[0].ordered_quantity || 600,
                target_quantity: salesOrders[0].ordered_quantity || 600,
                production_date: today,
                expected_completion_date: nextWeek,
                priority: "HIGH",
                shift: "DAY",
                supervisor_id: supervisorId,
                status: "IN_PROGRESS",
                remarks: "PVC Coating Line 01 scheduled for morning run."
            },
            {
                production_order_number: "PO-2026-0002",
                sales_order_id: salesOrders[1 % salesOrders.length].id,
                product_id: salesOrders[1 % salesOrders.length].product_id,
                planned_quantity: salesOrders[1 % salesOrders.length].ordered_quantity || 1200,
                target_quantity: salesOrders[1 % salesOrders.length].ordered_quantity || 1200,
                production_date: today,
                expected_completion_date: nextWeek,
                priority: "NORMAL",
                shift: "DAY",
                supervisor_id: supervisorId,
                status: "PLANNED",
                remarks: "Awaiting raw material plastisol mixing batch PST-2026-001."
            },
            {
                production_order_number: "PO-2026-0003",
                sales_order_id: salesOrders[2 % salesOrders.length].id,
                product_id: salesOrders[2 % salesOrders.length].product_id,
                planned_quantity: salesOrders[2 % salesOrders.length].ordered_quantity || 400,
                target_quantity: salesOrders[2 % salesOrders.length].ordered_quantity || 400,
                production_date: today,
                expected_completion_date: nextWeek,
                priority: "HIGH",
                shift: "NIGHT",
                supervisor_id: supervisorId,
                status: "READY",
                remarks: "Tooling and embossed print roll mounted on Line 02."
            }
        ];

        let seeded = 0;
        for (const po of sampleProductionOrders) {
            const [existing] = await pool.query(
                `SELECT id FROM production_orders WHERE production_order_number = ? LIMIT 1`,
                [po.production_order_number]
            );

            if (existing.length === 0) {
                await pool.query(`
                    INSERT INTO production_orders (
                        production_order_number,
                        sales_order_id,
                        product_id,
                        planned_quantity,
                        target_quantity,
                        production_date,
                        expected_completion_date,
                        priority,
                        shift,
                        supervisor_id,
                        status,
                        remarks
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    po.production_order_number,
                    po.sales_order_id,
                    po.product_id,
                    po.planned_quantity,
                    po.target_quantity,
                    po.production_date,
                    po.expected_completion_date,
                    po.priority,
                    po.shift,
                    po.supervisor_id,
                    po.status,
                    po.remarks
                ]);
                seeded++;
            }
        }

        res.json({
            success: true,
            message: `Successfully seeded ${seeded} production orders!`,
            count: seeded
        });

    } catch (error) {
        console.error("Seed Production Orders Error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to seed production orders",
            error: error.message
        });
    }
};

/*
=========================================================
EXPORTS
=========================================================
*/

module.exports = {
    getProductionOrders,
    getProductionOrderById,
    getProductionOrderOptions,
    createProductionOrder,
    updateProductionOrder,
    deleteProductionOrder,
    seedProductionOrders
};