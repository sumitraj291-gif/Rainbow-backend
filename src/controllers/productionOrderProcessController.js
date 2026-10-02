const pool = require("../config/database");


// =====================================================
// GET PROCESS FLOW FOR PRODUCTION ORDER
// =====================================================

const getProductionOrderProcesses = async (req, res) => {

    try {

        const { orderId } = req.params;

        const [rows] = await pool.query(`
            SELECT
                pop.id,
                pop.production_order_id,
                pop.product_process_id,
                pop.sequence_no,
                pop.process_status,
                pop.machine_id,
                pop.planned_quantity,
                pop.input_quantity,
                pop.good_quantity,
                pop.rejected_quantity,
                pop.wastage_quantity,
                pop.start_time,
                pop.end_time,
                pop.operator_id,
                pop.remarks,

                pp.process_id,

                p.process_code,
                p.process_name,
                p.department,

                m.machine_code,
                m.machine_name

            FROM production_order_processes pop

            INNER JOIN product_processes pp
                ON pp.id = pop.product_process_id

            INNER JOIN processes p
                ON p.id = pp.process_id

            LEFT JOIN machines m
                ON m.id = pop.machine_id

            WHERE pop.production_order_id = ?

            ORDER BY pop.sequence_no ASC
        `, [orderId]);


        res.json({
            success: true,
            data: rows
        });


    } catch (error) {

        console.error(
            "Get Production Order Processes Error:",
            error
        );

        res.status(500).json({
            success: false,
            message: "Unable to load production process flow",
            error: error.message
        });

    }

};



// =====================================================
// GENERATE PROCESS FLOW FROM PRODUCT ROUTING
// =====================================================

const generateProductionOrderProcesses = async (req, res) => {

    const connection = await pool.getConnection();

    try {

        const { orderId } = req.params;


        await connection.beginTransaction();


        // -------------------------------------------------
        // GET PRODUCTION ORDER
        // -------------------------------------------------

        const [orders] = await connection.query(`
            SELECT
                id,
                product_id,
                planned_quantity
            FROM production_orders
            WHERE id = ?
            LIMIT 1
        `, [orderId]);


        if (orders.length === 0) {

            await connection.rollback();

            return res.status(404).json({
                success: false,
                message: "Production order not found"
            });

        }


        const order = orders[0];


        // -------------------------------------------------
        // CHECK EXISTING PROCESS FLOW
        // -------------------------------------------------

        const [existing] = await connection.query(`
            SELECT id
            FROM production_order_processes
            WHERE production_order_id = ?
            LIMIT 1
        `, [orderId]);


        if (existing.length > 0) {

            await connection.rollback();

            return res.status(409).json({
                success: false,
                message: "Process flow has already been generated for this production order"
            });

        }


        // -------------------------------------------------
        // GET PRODUCT ROUTING
        // -------------------------------------------------

        const [routing] = await connection.query(`
            SELECT
                id,
                sequence_no,
                process_id,
                machine_id
            FROM product_processes
            WHERE product_id = ?
            ORDER BY sequence_no ASC
        `, [order.product_id]);


        if (routing.length === 0) {

            await connection.rollback();

            return res.status(400).json({
                success: false,
                message: "No product routing has been configured for this product"
            });

        }


        // -------------------------------------------------
        // CREATE PROCESS FLOW
        // -------------------------------------------------

        for (const route of routing) {

            await connection.query(`
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
                orderId,
                route.id,
                route.sequence_no,
                route.machine_id || null,
                order.planned_quantity
            ]);

        }


        // -------------------------------------------------
        // UPDATE PRODUCTION ORDER
        // -------------------------------------------------

        await connection.query(`
            UPDATE production_orders
            SET status = 'READY'
            WHERE id = ?
              AND status IN ('PLANNED', 'MATERIAL_PENDING')
        `, [orderId]);


        await connection.commit();


        res.status(201).json({
            success: true,
            message: "Production process flow generated successfully",
            data: {
                production_order_id: orderId,
                process_count: routing.length
            }
        });


    } catch (error) {

        await connection.rollback();

        console.error(
            "Generate Production Process Error:",
            error
        );

        res.status(500).json({
            success: false,
            message: "Unable to generate production process flow",
            error: error.message
        });

    } finally {

        connection.release();

    }

};




    // START PROCESS
const startProductionProcess = async (req, res) => {
    const connection = await pool.getConnection();

    try {
        const { id } = req.params;

        await connection.beginTransaction();

        const [rows] = await connection.query(`
            SELECT *
            FROM production_order_processes
            WHERE id = ?
            LIMIT 1
        `, [id]);

        if (rows.length === 0) {
            await connection.rollback();

            return res.status(404).json({
                success: false,
                message: "Production process not found"
            });
        }

        const process = rows[0];

        // Only PENDING process can be started
        if (process.process_status !== "PENDING") {
            await connection.rollback();

            return res.status(400).json({
                success: false,
                message: `Process cannot be started because its current status is ${process.process_status}`
            });
        }

        // Check previous process
        if (process.sequence_no > 1) {
            const [previous] = await connection.query(`
                SELECT process_status
                FROM production_order_processes
                WHERE production_order_id = ?
                  AND sequence_no < ?
                ORDER BY sequence_no DESC
                LIMIT 1
            `, [
                process.production_order_id,
                process.sequence_no
            ]);

            if (
                previous.length > 0 &&
                previous[0].process_status !== "COMPLETED"
            ) {
                await connection.rollback();

                return res.status(400).json({
                    success: false,
                    message: "Previous process must be completed first"
                });
            }
        }

        // Start process
        await connection.query(`
            UPDATE production_order_processes
            SET process_status = 'RUNNING',
                start_time = NOW(),
                end_time = NULL,
                input_quantity = 0,
                good_quantity = 0,
                rejected_quantity = 0,
                wastage_quantity = 0,
                remarks = NULL
            WHERE id = ?
        `, [id]);

        // Update production order
        await connection.query(`
            UPDATE production_orders
            SET status = 'IN_PROGRESS'
            WHERE id = ?
        `, [process.production_order_id]);

        await connection.commit();

        res.json({
            success: true,
            message: "Production process started successfully"
        });

    } catch (error) {

        await connection.rollback();

        console.error("Start Production Process Error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to start production process",
            error: error.message
        });

    } finally {
        connection.release();
    }
};



// =====================================================
// COMPLETE PROCESS
// =====================================================

const completeProductionProcess = async (req, res) => {

    const connection = await pool.getConnection();

    try {

        const { id } = req.params;

        const {
            input_quantity,
            good_quantity,
            rejected_quantity,
            wastage_quantity,
            remarks
        } = req.body;


        const input = Number(input_quantity !== undefined && input_quantity !== null && input_quantity !== "" ? input_quantity : (req.body.completed_qty || 0));
        const good = Number(good_quantity !== undefined && good_quantity !== null && good_quantity !== "" ? good_quantity : (req.body.completed_qty || 0));
        const rejected = Number(rejected_quantity !== undefined && rejected_quantity !== null && rejected_quantity !== "" ? rejected_quantity : (req.body.scrap_qty || 0));
        const wastage = Number(wastage_quantity !== undefined && wastage_quantity !== null && wastage_quantity !== "" ? wastage_quantity : 0);


        if (input <= 0) {

            return res.status(400).json({
                success: false,
                message: "Input quantity must be greater than zero"
            });

        }


        if (good < 0 || rejected < 0 || wastage < 0) {

            return res.status(400).json({
                success: false,
                message: "Production quantities cannot be negative"
            });

        }


        if ((good + rejected + wastage) > input) {

            return res.status(400).json({
                success: false,
                message: "Good, rejected and wastage quantity cannot exceed input quantity"
            });

        }


        await connection.beginTransaction();


        const [rows] = await connection.query(`
            SELECT *
            FROM production_order_processes
            WHERE id = ?
            LIMIT 1
        `, [id]);


        if (rows.length === 0) {

            await connection.rollback();

            return res.status(404).json({
                success: false,
                message: "Production process not found"
            });

        }


        const process = rows[0];


        if (process.process_status !== "RUNNING") {

            await connection.rollback();

            return res.status(400).json({
                success: false,
                message: "Only a running process can be completed"
            });

        }


        await connection.query(`
            UPDATE production_order_processes

            SET
                process_status = 'COMPLETED',
                input_quantity = ?,
                good_quantity = ?,
                rejected_quantity = ?,
                wastage_quantity = ?,
                end_time = NOW(),
                remarks = ?

            WHERE id = ?
        `, [
            input,
            good,
            rejected,
            wastage,
            remarks || null,
            id
        ]);


        // -------------------------------------------------
        // CHECK NEXT PROCESS
        // -------------------------------------------------

        const [nextProcess] = await connection.query(`
            SELECT id
            FROM production_order_processes

            WHERE production_order_id = ?
              AND sequence_no > ?

            ORDER BY sequence_no ASC

            LIMIT 1
        `, [
            process.production_order_id,
            process.sequence_no
        ]);


        if (nextProcess.length > 0) {

            await connection.query(`
                UPDATE production_order_processes

                SET process_status = 'PENDING'

                WHERE id = ?
            `, [nextProcess[0].id]);


        } else {

            // -------------------------------------------------
            // LAST PROCESS COMPLETED
            // -------------------------------------------------

            await connection.query(`
                UPDATE production_orders

                SET status = 'QC_PENDING'

                WHERE id = ?
            `, [process.production_order_id]);

        }


        await connection.commit();


        res.json({
            success: true,
            message: "Production process completed successfully"
        });


    } catch (error) {

        await connection.rollback();

        console.error(
            "Complete Production Process Error:",
            error
        );

        res.status(500).json({
            success: false,
            message: "Unable to complete production process",
            error: error.message
        });

    } finally {

        connection.release();

    }

};



module.exports = {

    getProductionOrderProcesses,

    generateProductionOrderProcesses,

    startProductionProcess,

    completeProductionProcess

};