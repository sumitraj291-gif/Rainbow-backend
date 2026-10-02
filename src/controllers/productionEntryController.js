const pool = require("../config/database");

/*
=========================================================
GET ALL PRODUCTION ENTRIES
=========================================================
*/
const getProductionEntries = async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT
                pe.id,

                pe.production_order_id,
                po.production_order_number,

                po.product_id,
                p.product_code,
                p.product_name,

                pe.machine_id,
                m.machine_code,
                m.machine_name,

                pe.operator_id,

                pe.production_date,
                pe.shift,

                pe.start_time,
                pe.end_time,

                pe.input_quantity,
                pe.good_quantity,
                pe.rejected_quantity,
                pe.wastage_quantity,

                pe.downtime_minutes,
                pe.remarks,

                pe.created_at

            FROM production_entries pe

            INNER JOIN production_orders po
                ON po.id = pe.production_order_id

            INNER JOIN products p
                ON p.id = po.product_id

            LEFT JOIN machines m
                ON m.id = pe.machine_id

            ORDER BY
                pe.production_date DESC,
                pe.id DESC
        `);

        res.json({
            success: true,
            data: rows
        });

    } catch (error) {

        console.error(
            "Get Production Entries Error:",
            error
        );

        res.status(500).json({
            success: false,
            message: "Unable to load production entries",
            error: error.message
        });
    }
};


/*
=========================================================
GET PRODUCTION ENTRY BY ID
=========================================================
*/
const getProductionEntryById = async (req, res) => {

    try {

        const { id } = req.params;

        const [rows] = await pool.query(`
            SELECT
                pe.*,

                po.production_order_number,

                p.product_code,
                p.product_name,

                m.machine_code,
                m.machine_name

            FROM production_entries pe

            INNER JOIN production_orders po
                ON po.id = pe.production_order_id

            INNER JOIN products p
                ON p.id = po.product_id

            LEFT JOIN machines m
                ON m.id = pe.machine_id

            WHERE pe.id = ?

            LIMIT 1
        `, [id]);

        if (rows.length === 0) {

            return res.status(404).json({
                success: false,
                message: "Production entry not found"
            });

        }

        res.json({
            success: true,
            data: rows[0]
        });

    } catch (error) {

        console.error(
            "Get Production Entry Error:",
            error
        );

        res.status(500).json({
            success: false,
            message: "Unable to load production entry",
            error: error.message
        });
    }
};


/*
=========================================================
GET PRODUCTION ENTRY OPTIONS
=========================================================
*/
const getProductionEntryOptions = async (req, res) => {

    try {

        /*
        Only production orders that can receive
        production entries.
        */

        const [productionOrders] = await pool.query(`
            SELECT
                po.id,
                po.production_order_number,

                po.product_id,

                p.product_code,
                p.product_name,

                po.planned_quantity,
                po.target_quantity,
                po.status,

                COALESCE(
                    (
                        SELECT SUM(pe.good_quantity)
                        FROM production_entries pe
                        WHERE pe.production_order_id = po.id
                    ),
                    0
                ) AS good_quantity

            FROM production_orders po

            INNER JOIN products p
                ON p.id = po.product_id

            WHERE po.status NOT IN (
                'COMPLETED',
                'CANCELLED'
            )

            ORDER BY
                po.created_at DESC
        `);


        /*
        Active machines
        */

        const [machines] = await pool.query(`
            SELECT
                id,
                machine_code,
                machine_name,
                machine_type,
                status,
                capacity_per_hour

            FROM machines

            WHERE status != 'INACTIVE'

            ORDER BY machine_name ASC
        `);


        res.json({
            success: true,
            data: {
                productionOrders,
                machines
            }
        });

    } catch (error) {

        console.error(
            "Get Production Entry Options Error:",
            error
        );

        res.status(500).json({
            success: false,
            message: "Unable to load production entry options",
            error: error.message
        });
    }
};


/*
=========================================================
VALIDATE QUANTITIES
=========================================================
*/
const validateQuantities = (
    input_quantity,
    good_quantity,
    rejected_quantity,
    wastage_quantity
) => {

    const input = Number(input_quantity || 0);
    const good = Number(good_quantity || 0);
    const rejected = Number(rejected_quantity || 0);
    const wastage = Number(wastage_quantity || 0);

    if (input <= 0) {
        return "Input quantity must be greater than zero";
    }

    if (good < 0 || rejected < 0 || wastage < 0) {
        return "Good, rejected and wastage quantities cannot be negative";
    }

    const total =
        good +
        rejected +
        wastage;

    if (total > input) {
        return (
            "Good + rejected + wastage quantity cannot be greater than input quantity"
        );
    }

    return null;
};


/*
=========================================================
CREATE PRODUCTION ENTRY
=========================================================
*/
const createProductionEntry = async (req, res) => {

    const connection = await pool.getConnection();

    try {

        const {
            production_order_id,
            machine_id,
            operator_id,
            production_date,
            shift,
            start_time,
            end_time,
            input_quantity,
            good_quantity,
            rejected_quantity,
            wastage_quantity,
            downtime_minutes,
            remarks
        } = req.body;


        /*
        VALIDATION
        */

        if (!production_order_id) {

            return res.status(400).json({
                success: false,
                message: "Production order is required"
            });

        }


        const prodDate = production_date || req.body.entry_date;

        if (!prodDate) {

            return res.status(400).json({
                success: false,
                message: "Production date is required"
            });

        }


        const inputQty = input_quantity !== undefined && input_quantity !== null && input_quantity !== "" ? input_quantity : (req.body.total_qty || req.body.input_qty);
        const goodQty = good_quantity !== undefined && good_quantity !== null && good_quantity !== "" ? good_quantity : req.body.good_qty;
        const rejectedQty = rejected_quantity !== undefined && rejected_quantity !== null && rejected_quantity !== "" ? rejected_quantity : (req.body.rejected_qty || 0);
        const wastageQty = wastage_quantity !== undefined && wastage_quantity !== null && wastage_quantity !== "" ? wastage_quantity : (req.body.wastage_qty || 0);

        const quantityError =
            validateQuantities(
                inputQty,
                goodQty,
                rejectedQty,
                wastageQty
            );

        if (quantityError) {

            return res.status(400).json({
                success: false,
                message: quantityError
            });

        }


        if (
            downtime_minutes !== undefined &&
            Number(downtime_minutes) < 0
        ) {

            return res.status(400).json({
                success: false,
                message: "Downtime cannot be negative"
            });

        }


        /*
        CHECK PRODUCTION ORDER
        */

        const [orders] = await pool.query(`
            SELECT
                id,
                production_order_number,
                product_id,
                planned_quantity,
                status

            FROM production_orders

            WHERE id = ?

            LIMIT 1
        `, [production_order_id]);


        if (orders.length === 0) {

            return res.status(400).json({
                success: false,
                message: "Selected production order does not exist"
            });

        }


        const productionOrder = orders[0];


        if (
            productionOrder.status === "COMPLETED" ||
            productionOrder.status === "CANCELLED"
        ) {

            return res.status(400).json({
                success: false,
                message:
                    `Production order ${productionOrder.production_order_number} is ${productionOrder.status} and cannot receive new production entries`
            });

        }


        /*
        CHECK MACHINE
        */

        if (machine_id) {

            const [machines] = await pool.query(`
                SELECT
                    id,
                    status

                FROM machines

                WHERE id = ?

                LIMIT 1
            `, [machine_id]);


            if (machines.length === 0) {

                return res.status(400).json({
                    success: false,
                    message: "Selected machine does not exist"
                });

            }


            if (machines[0].status === "INACTIVE") {

                return res.status(400).json({
                    success: false,
                    message: "Selected machine is inactive"
                });

            }

        }


        /*
        TRANSACTION
        */

        await connection.beginTransaction();


        const [result] = await connection.query(`
            INSERT INTO production_entries
            (
                production_order_id,
                machine_id,
                operator_id,
                production_date,
                shift,
                start_time,
                end_time,
                input_quantity,
                good_quantity,
                rejected_quantity,
                wastage_quantity,
                downtime_minutes,
                remarks
            )

            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [

            production_order_id,

            machine_id || null,

            operator_id || null,

            prodDate,

            shift || "DAY",

            start_time || null,

            end_time || null,

            Number(inputQty || 0),

            Number(goodQty || 0),

            Number(rejectedQty || 0),

            Number(wastageQty || 0),

            Number(downtime_minutes || 0),

            remarks || null
        ]);


        /*
        UPDATE PRODUCTION ORDER STATUS
        */

        await connection.query(`
            UPDATE production_orders

            SET status = 'IN_PROGRESS'

            WHERE id = ?

              AND status IN (
                  'PLANNED',
                  'MATERIAL_PENDING',
                  'READY'
              )
        `, [production_order_id]);


        await connection.commit();


        res.status(201).json({

            success: true,

            message:
                "Production entry created successfully",

            data: {
                id: result.insertId
            }

        });

    } catch (error) {

        await connection.rollback();

        console.error(
            "Create Production Entry Error:",
            error
        );

        res.status(500).json({
            success: false,
            message: "Unable to create production entry",
            error: error.message
        });

    } finally {

        connection.release();

    }
};


/*
=========================================================
UPDATE PRODUCTION ENTRY
=========================================================
*/
const updateProductionEntry = async (req, res) => {

    try {

        const { id } = req.params;

        const {
            production_order_id,
            machine_id,
            operator_id,
            production_date,
            shift,
            start_time,
            end_time,
            input_quantity,
            good_quantity,
            rejected_quantity,
            wastage_quantity,
            downtime_minutes,
            remarks
        } = req.body;


        /*
        CHECK ENTRY
        */

        const [entries] = await pool.query(`
            SELECT
                id

            FROM production_entries

            WHERE id = ?

            LIMIT 1
        `, [id]);


        if (entries.length === 0) {

            return res.status(404).json({
                success: false,
                message: "Production entry not found"
            });

        }


        /*
        VALIDATION
        */

        if (!production_order_id) {

            return res.status(400).json({
                success: false,
                message: "Production order is required"
            });

        }


        const quantityError =
            validateQuantities(
                input_quantity,
                good_quantity,
                rejected_quantity,
                wastage_quantity
            );

        if (quantityError) {

            return res.status(400).json({
                success: false,
                message: quantityError
            });

        }


        /*
        CHECK ORDER
        */

        const [orders] = await pool.query(`
            SELECT
                id,
                status

            FROM production_orders

            WHERE id = ?

            LIMIT 1
        `, [production_order_id]);


        if (orders.length === 0) {

            return res.status(400).json({
                success: false,
                message: "Production order does not exist"
            });

        }


        if (
            orders[0].status === "CANCELLED"
        ) {

            return res.status(400).json({
                success: false,
                message:
                    "Production entry cannot be assigned to a cancelled production order"
            });

        }


        /*
        CHECK MACHINE
        */

        if (machine_id) {

            const [machines] = await pool.query(`
                SELECT
                    id,
                    status

                FROM machines

                WHERE id = ?

                LIMIT 1
            `, [machine_id]);


            if (machines.length === 0) {

                return res.status(400).json({
                    success: false,
                    message: "Selected machine does not exist"
                });

            }

        }


        /*
        UPDATE
        */

        await pool.query(`
            UPDATE production_entries

            SET
                production_order_id = ?,
                machine_id = ?,
                operator_id = ?,
                production_date = ?,
                shift = ?,
                start_time = ?,
                end_time = ?,
                input_quantity = ?,
                good_quantity = ?,
                rejected_quantity = ?,
                wastage_quantity = ?,
                downtime_minutes = ?,
                remarks = ?

            WHERE id = ?
        `, [

            production_order_id,

            machine_id || null,

            operator_id || null,

            production_date,

            shift || "DAY",

            start_time || null,

            end_time || null,

            Number(input_quantity || 0),

            Number(good_quantity || 0),

            Number(rejected_quantity || 0),

            Number(wastage_quantity || 0),

            Number(downtime_minutes || 0),

            remarks || null,

            id

        ]);


        /*
        MAKE SURE ORDER IS IN PROGRESS
        */

        await pool.query(`
            UPDATE production_orders

            SET status = 'IN_PROGRESS'

            WHERE id = ?

              AND status IN (
                  'PLANNED',
                  'MATERIAL_PENDING',
                  'READY'
              )
        `, [production_order_id]);


        res.json({

            success: true,

            message:
                "Production entry updated successfully"

        });

    } catch (error) {

        console.error(
            "Update Production Entry Error:",
            error
        );

        res.status(500).json({
            success: false,
            message: "Unable to update production entry",
            error: error.message
        });
    }
};


/*
=========================================================
DELETE PRODUCTION ENTRY
=========================================================
*/
const deleteProductionEntry = async (req, res) => {

    const connection = await pool.getConnection();

    try {

        const { id } = req.params;


        const [entries] = await connection.query(`
            SELECT
                id,
                production_order_id

            FROM production_entries

            WHERE id = ?

            LIMIT 1
        `, [id]);


        if (entries.length === 0) {

            return res.status(404).json({
                success: false,
                message: "Production entry not found"
            });

        }


        const productionOrderId =
            entries[0].production_order_id;


        await connection.beginTransaction();


        await connection.query(`
            DELETE FROM production_entries

            WHERE id = ?
        `, [id]);


        /*
        If no production entries remain,
        move the order back to READY.
        */

        const [remaining] = await connection.query(`
            SELECT COUNT(*) AS total

            FROM production_entries

            WHERE production_order_id = ?
        `, [productionOrderId]);


        if (
            Number(remaining[0].total) === 0
        ) {

            await connection.query(`
                UPDATE production_orders

                SET status = 'READY'

                WHERE id = ?

                  AND status = 'IN_PROGRESS'
            `, [productionOrderId]);

        }


        await connection.commit();


        res.json({

            success: true,

            message:
                "Production entry deleted successfully"

        });

    } catch (error) {

        await connection.rollback();

        console.error(
            "Delete Production Entry Error:",
            error
        );

        res.status(500).json({
            success: false,
            message: "Unable to delete production entry",
            error: error.message
        });

    } finally {
        connection.release();
    }
};

/*
=========================================================
SEED SAMPLE PRODUCTION ENTRIES
=========================================================
*/
const seedProductionEntries = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // Check if entries already exist
        const [existing] = await connection.query("SELECT COUNT(*) AS count FROM production_entries");
        if (existing[0].count > 0) {
            connection.release();
            return res.json({
                success: true,
                message: "Production entries already exist in the database.",
                count: existing[0].count
            });
        }

        // Fetch active production orders and machines
        const [pos] = await connection.query("SELECT id, production_order_number FROM production_orders ORDER BY id ASC LIMIT 3");
        const [machines] = await connection.query("SELECT id, machine_code FROM machines WHERE status = 'RUNNING' ORDER BY id ASC LIMIT 3");

        if (pos.length === 0) {
            connection.release();
            return res.status(400).json({
                success: false,
                message: "Please create or seed Production Orders first before adding production entries."
            });
        }

        const sampleEntries = [
            {
                poId: pos[0].id,
                machineId: machines[0]?.id || null,
                date: new Date().toISOString().substring(0, 10),
                shift: "DAY",
                startTime: "08:30:00",
                endTime: "16:30:00",
                input: 200,
                good: 192,
                rejected: 5,
                wastage: 3,
                downtime: 25,
                remarks: "First morning shift batch completed on Tufting / Plastisol line."
            },
            {
                poId: pos[1] ? pos[1].id : pos[0].id,
                machineId: machines[1]?.id || machines[0]?.id || null,
                date: new Date().toISOString().substring(0, 10),
                shift: "DAY",
                startTime: "09:00:00",
                endTime: "17:00:00",
                input: 150,
                good: 145,
                rejected: 3,
                wastage: 2,
                downtime: 15,
                remarks: "Brown Spike Mat backing adhesion run. Smooth operation."
            },
            {
                poId: pos[2] ? pos[2].id : pos[0].id,
                machineId: machines[2]?.id || machines[0]?.id || null,
                date: new Date().toISOString().substring(0, 10),
                shift: "NIGHT",
                startTime: "20:00:00",
                endTime: "04:30:00",
                input: 300,
                good: 288,
                rejected: 8,
                wastage: 4,
                downtime: 35,
                remarks: "Night shift high-volume PVC roll slitting. Minor blade adjustment downtime."
            }
        ];

        for (const item of sampleEntries) {
            await connection.query(`
                INSERT INTO production_entries (
                    production_order_id, machine_id, production_date, shift,
                    start_time, end_time, input_quantity, good_quantity,
                    rejected_quantity, wastage_quantity, downtime_minutes, remarks
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                item.poId, item.machineId, item.date, item.shift,
                item.startTime, item.endTime, item.input, item.good,
                item.rejected, item.wastage, item.downtime, item.remarks
            ]);

            // Update PO to IN_PROGRESS
            await connection.query(`
                UPDATE production_orders
                SET status = 'IN_PROGRESS'
                WHERE id = ? AND status IN ('PLANNED', 'MATERIAL_PENDING', 'READY')
            `, [item.poId]);
        }

        await connection.commit();

        res.json({
            success: true,
            message: `Successfully seeded ${sampleEntries.length} shop-floor production entries!`
        });
    } catch (err) {
        await connection.rollback();
        console.error("Seed Production Entries Error:", err);
        res.status(500).json({
            success: false,
            message: "Unable to seed production entries",
            error: err.message
        });
    } finally {
        connection.release();
    }
};

module.exports = {
    getProductionEntries,
    getProductionEntryById,
    getProductionEntryOptions,
    createProductionEntry,
    updateProductionEntry,
    deleteProductionEntry,
    seedProductionEntries
};