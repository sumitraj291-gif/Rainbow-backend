const pool = require("../config/database");

/**
 * Generate unique dispatch number: DSP-YYYYMMDD-XXXX
 */
const generateDispatchNumber = async (connection) => {
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, "");
    const prefix = `DSP-${dateStr}-`;

    const [rows] = await connection.query(
        `SELECT dispatch_number FROM dispatches WHERE dispatch_number LIKE ? ORDER BY id DESC LIMIT 1`,
        [`${prefix}%`]
    );

    let seq = 1;
    if (rows.length > 0) {
        const lastNumber = rows[0].dispatch_number;
        const parts = lastNumber.split("-");
        const lastSeq = parseInt(parts[2], 10);
        if (!isNaN(lastSeq)) {
            seq = lastSeq + 1;
        }
    }

    return `${prefix}${String(seq).padStart(4, "0")}`;
};

// =========================================================
// 1. GET FINISHED GOODS INVENTORY SUMMARY (AGGREGATED)
// =========================================================
const getInventorySummary = async (req, res) => {
    try {
        const { search, product_id, location } = req.query;

        let query = `
            SELECT 
                p.id AS product_id,
                p.product_code,
                p.product_name,
                p.carpet_type,
                p.design_pattern,
                p.colour,
                COUNT(cr.id) AS total_rolls,
                COALESCE(SUM(cr.length_m), 0) AS total_length_m,
                COALESCE(SUM(cr.area_sqm), 0) AS total_area_sqm,
                COALESCE(SUM(cr.net_weight_kg), 0) AS total_weight_kg,
                GROUP_CONCAT(DISTINCT cr.warehouse_location ORDER BY cr.warehouse_location SEPARATOR ', ') AS warehouse_locations
            FROM carpet_rolls cr
            INNER JOIN products p ON p.id = cr.product_id
            WHERE cr.status = 'IN_WAREHOUSE'
        `;

        const params = [];

        if (product_id) {
            query += ` AND cr.product_id = ?`;
            params.push(product_id);
        }

        if (location) {
            query += ` AND cr.warehouse_location LIKE ?`;
            params.push(`%${location}%`);
        }

        if (search) {
            query += ` AND (p.product_code LIKE ? OR p.product_name LIKE ? OR p.colour LIKE ? OR p.design_pattern LIKE ?)`;
            const s = `%${search}%`;
            params.push(s, s, s, s);
        }

        query += `
            GROUP BY p.id, p.product_code, p.product_name, p.carpet_type, p.design_pattern, p.colour
            ORDER BY total_rolls DESC
        `;

        const [productsSummary] = await pool.query(query, params);

        // Also fetch individual rolls grouped under each product
        for (let item of productsSummary) {
            const [rolls] = await pool.query(
                `SELECT 
                    id, roll_number, production_order_id, width_m, length_m, area_sqm, 
                    net_weight_kg, grade, warehouse_location, stocked_at, barcode
                 FROM carpet_rolls 
                 WHERE product_id = ? AND status = 'IN_WAREHOUSE'
                 ORDER BY id DESC`,
                [item.product_id]
            );
            item.rolls = rolls;
        }

        res.json({
            success: true,
            data: productsSummary
        });
    } catch (error) {
        console.error("GET INVENTORY SUMMARY ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch finished goods inventory summary",
            error: error.message
        });
    }
};

// =========================================================
// 2. GET FINISHED GOODS KPIS
// =========================================================
const getKPIs = async (req, res) => {
    try {
        const [stockStats] = await pool.query(`
            SELECT 
                COUNT(*) AS total_rolls_in_stock,
                COALESCE(SUM(length_m), 0) AS total_length_m,
                COALESCE(SUM(area_sqm), 0) AS total_area_sqm,
                COALESCE(SUM(net_weight_kg), 0) AS total_weight_kg,
                SUM(CASE WHEN grade IN ('GRADE_A', 'GRADE_B') THEN 1 ELSE 0 END) AS ready_for_dispatch
            FROM carpet_rolls 
            WHERE status = 'IN_WAREHOUSE'
        `);

        const [dispatchStats] = await pool.query(`
            SELECT 
                COUNT(*) AS total_dispatched_rolls,
                SUM(CASE WHEN DATE(dispatched_at) = CURDATE() THEN 1 ELSE 0 END) AS dispatched_today_rolls
            FROM carpet_rolls 
            WHERE status = 'DISPATCHED'
        `);

        const [totalDispatches] = await pool.query(`
            SELECT COUNT(*) AS total_challans FROM dispatches
        `);

        const [approvedAwaitingStock] = await pool.query(`
            SELECT COUNT(*) AS awaiting_stock_rolls
            FROM carpet_rolls
            WHERE status IN ('APPROVED', 'PRODUCED')
        `);

        const stock = stockStats[0] || {};
        const dispatch = dispatchStats[0] || {};

        res.json({
            success: true,
            data: {
                total_rolls_in_stock: parseInt(stock.total_rolls_in_stock || 0, 10),
                total_length_m: parseFloat(stock.total_length_m || 0).toFixed(2),
                total_area_sqm: parseFloat(stock.total_area_sqm || 0).toFixed(2),
                total_area_sqft: (parseFloat(stock.total_area_sqm || 0) * 10.764).toFixed(1),
                total_weight_kg: parseFloat(stock.total_weight_kg || 0).toFixed(2),
                ready_for_dispatch: parseInt(stock.ready_for_dispatch || 0, 10),
                dispatched_today_rolls: parseInt(dispatch.dispatched_today_rolls || 0, 10),
                total_dispatched_rolls: parseInt(dispatch.total_dispatched_rolls || 0, 10),
                total_challans: parseInt(totalDispatches[0]?.total_challans || 0, 10),
                awaiting_stock_rolls: parseInt(approvedAwaitingStock[0]?.awaiting_stock_rolls || 0, 10)
            }
        });
    } catch (error) {
        console.error("GET KPIS ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch finished goods KPIs",
            error: error.message
        });
    }
};

// =========================================================
// 3. STOCK-IN ROLLS TO FINISHED GOODS WAREHOUSE
// =========================================================
const stockInRolls = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const { roll_ids, warehouse_id = 3, warehouse_location = "FG-BAY-01" } = req.body;

        if (!roll_ids || !Array.isArray(roll_ids) || roll_ids.length === 0) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "Please select at least one roll to stock into the warehouse."
            });
        }

        // Fetch rolls
        const [rolls] = await connection.query(
            `SELECT id, roll_number, product_id, production_order_id, area_sqm, net_weight_kg, status 
             FROM carpet_rolls 
             WHERE id IN (?)`,
            [roll_ids]
        );

        if (rolls.length === 0) {
            await connection.rollback();
            return res.status(404).json({
                success: false,
                message: "No matching rolls found."
            });
        }

        // Update roll statuses
        await connection.query(
            `UPDATE carpet_rolls 
             SET status = 'IN_WAREHOUSE', 
                 warehouse_id = ?, 
                 warehouse_location = ?, 
                 stocked_at = NOW() 
             WHERE id IN (?)`,
            [warehouse_id, warehouse_location, roll_ids]
        );

        // Update or insert into finished_goods table for inventory aggregation
        for (const roll of rolls) {
            const [existingFg] = await connection.query(
                `SELECT id, quantity_produced, quantity_available 
                 FROM finished_goods 
                 WHERE product_id = ? AND production_order_id = ? 
                 LIMIT 1`,
                [roll.product_id, roll.production_order_id]
            );

            if (existingFg.length > 0) {
                await connection.query(
                    `UPDATE finished_goods 
                     SET quantity_produced = quantity_produced + 1,
                         quantity_available = quantity_available + 1,
                         warehouse_id = ?,
                         updated_at = NOW()
                     WHERE id = ?`,
                    [warehouse_id, existingFg[0].id]
                );
            } else {
                await connection.query(
                    `INSERT INTO finished_goods (
                        product_id, production_order_id, batch_number, 
                        quantity_produced, quantity_available, warehouse_id, qc_status, production_date
                    ) VALUES (?, ?, ?, 1, 1, ?, 'APPROVED', CURDATE())`,
                    [roll.product_id, roll.production_order_id, roll.roll_number, warehouse_id]
                );
            }

            // Record stock transaction audit
            await connection.query(
                `INSERT INTO stock_transactions (
                    product_id, warehouse_id, transaction_type, reference_type, 
                    reference_id, quantity, transaction_date, remarks
                ) VALUES (?, ?, 'PRODUCTION_RECEIPT', 'carpet_rolls', ?, 1, NOW(), ?)`,
                [
                    roll.product_id,
                    warehouse_id,
                    roll.id,
                    `Stocked roll ${roll.roll_number} into ${warehouse_location}`
                ]
            );
        }

        await connection.commit();

        res.json({
            success: true,
            message: `Successfully stocked ${rolls.length} roll(s) into ${warehouse_location}.`,
            stocked_count: rolls.length
        });
    } catch (error) {
        await connection.rollback();
        console.error("STOCK IN ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to stock in carpet rolls",
            error: error.message
        });
    } finally {
        connection.release();
    }
};

// =========================================================
// 4. CREATE DISPATCH (DELIVERY CHALLAN & ROLL DEDUCTION)
// =========================================================
const createDispatch = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const {
            customer_id,
            sales_order_id,
            roll_ids,
            invoice_number,
            vehicle_number,
            driver_name,
            driver_phone,
            transporter_name,
            remarks,
            dispatch_date
        } = req.body;

        if (!customer_id) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "Customer is required for dispatch."
            });
        }

        if (!roll_ids || !Array.isArray(roll_ids) || roll_ids.length === 0) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "Please select at least one roll to dispatch."
            });
        }

        // Fetch rolls
        const [rolls] = await connection.query(
            `SELECT id, roll_number, product_id, production_order_id, length_m, area_sqm, net_weight_kg, status 
             FROM carpet_rolls 
             WHERE id IN (?)`,
            [roll_ids]
        );

        if (rolls.length !== roll_ids.length) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "One or more selected rolls could not be verified."
            });
        }

        // Generate dispatch number
        const dispatch_number = await generateDispatchNumber(connection);
        const finalDate = dispatch_date || new Date().toISOString().slice(0, 10);

        // Insert into dispatches
        const [dispatchResult] = await connection.query(
            `INSERT INTO dispatches (
                dispatch_number, customer_id, sales_order_id, dispatch_date, 
                invoice_number, vehicle_number, driver_name, driver_phone, 
                transporter_name, status, remarks
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'DISPATCHED', ?)`,
            [
                dispatch_number,
                customer_id,
                sales_order_id || null,
                finalDate,
                invoice_number || null,
                vehicle_number || null,
                driver_name || null,
                driver_phone || null,
                transporter_name || null,
                remarks || null
            ]
        );

        const dispatchId = dispatchResult.insertId;

        // Insert dispatch items & update each roll
        for (const roll of rolls) {
            const [fgRows] = await connection.query(
                `SELECT id FROM finished_goods WHERE product_id = ? AND production_order_id = ? LIMIT 1`,
                [roll.product_id, roll.production_order_id]
            );
            const finishedGoodId = fgRows[0]?.id || null;

            await connection.query(
                `INSERT INTO dispatch_items (
                    dispatch_id, finished_good_id, roll_id, roll_number, length_m, area_sqm, weight_kg, quantity
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
                [
                    dispatchId,
                    finishedGoodId,
                    roll.id,
                    roll.roll_number,
                    roll.length_m,
                    roll.area_sqm,
                    roll.net_weight_kg
                ]
            );

            // Update roll status to DISPATCHED
            await connection.query(
                `UPDATE carpet_rolls 
                 SET status = 'DISPATCHED', 
                     dispatch_id = ?, 
                     dispatched_at = NOW(),
                     customer_id = ?
                 WHERE id = ?`,
                [dispatchId, customer_id, roll.id]
            );

            // Deduct available quantity in finished_goods
            await connection.query(
                `UPDATE finished_goods 
                 SET quantity_available = GREATEST(0, quantity_available - 1),
                     updated_at = NOW() 
                 WHERE product_id = ? AND production_order_id = ?`,
                [roll.product_id, roll.production_order_id]
            );

            // Record stock transaction audit
            await connection.query(
                `INSERT INTO stock_transactions (
                    product_id, warehouse_id, transaction_type, reference_type, 
                    reference_id, quantity, transaction_date, remarks
                ) VALUES (?, 3, 'DISPATCH', 'dispatches', ?, 1, NOW(), ?)`,
                [
                    roll.product_id,
                    dispatchId,
                    `Dispatched roll ${roll.roll_number} via Challan ${dispatch_number}`
                ]
            );
        }

        await connection.commit();

        res.status(201).json({
            success: true,
            message: `Dispatch Challan ${dispatch_number} created successfully with ${rolls.length} rolls.`,
            dispatch_id: dispatchId,
            dispatch_number
        });
    } catch (error) {
        await connection.rollback();
        console.error("CREATE DISPATCH ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to create dispatch",
            error: error.message
        });
    } finally {
        connection.release();
    }
};

// =========================================================
// 5. GET ALL DISPATCHES (CHALLANS & SHIPMENTS)
// =========================================================
const getDispatches = async (req, res) => {
    try {
        const { search, customer_id, from_date, to_date } = req.query;

        let query = `
            SELECT 
                d.id,
                d.dispatch_number,
                d.customer_id,
                c.company_name AS customer_name,
                c.phone AS customer_phone,
                c.shipping_address,
                c.city AS customer_city,
                d.sales_order_id,
                so.order_number AS sales_order_number,
                d.dispatch_date,
                d.invoice_number,
                d.vehicle_number,
                d.driver_name,
                d.driver_phone,
                d.transporter_name,
                d.status,
                d.remarks,
                d.created_at,
                COUNT(di.id) AS total_rolls,
                COALESCE(SUM(di.length_m), 0) AS total_length_m,
                COALESCE(SUM(di.area_sqm), 0) AS total_area_sqm,
                COALESCE(SUM(di.weight_kg), 0) AS total_weight_kg
            FROM dispatches d
            INNER JOIN customers c ON c.id = d.customer_id
            LEFT JOIN sales_orders so ON so.id = d.sales_order_id
            LEFT JOIN dispatch_items di ON di.dispatch_id = d.id
            WHERE 1=1
        `;

        const params = [];

        if (customer_id) {
            query += ` AND d.customer_id = ?`;
            params.push(customer_id);
        }

        if (from_date) {
            query += ` AND d.dispatch_date >= ?`;
            params.push(from_date);
        }

        if (to_date) {
            query += ` AND d.dispatch_date <= ?`;
            params.push(to_date);
        }

        if (search) {
            query += ` AND (d.dispatch_number LIKE ? OR d.invoice_number LIKE ? OR d.vehicle_number LIKE ? OR c.company_name LIKE ?)`;
            const s = `%${search}%`;
            params.push(s, s, s, s);
        }

        query += `
            GROUP BY d.id
            ORDER BY d.id DESC
        `;

        const [dispatches] = await pool.query(query, params);

        res.json({
            success: true,
            data: dispatches
        });
    } catch (error) {
        console.error("GET DISPATCHES ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch dispatches",
            error: error.message
        });
    }
};

// =========================================================
// 6. GET SINGLE DISPATCH BY ID (PRINTABLE CHALLAN DETAIL)
// =========================================================
const getDispatchById = async (req, res) => {
    try {
        const { id } = req.params;

        const [dispatchRows] = await pool.query(
            `SELECT 
                d.*,
                c.customer_code,
                c.company_name AS customer_name,
                c.contact_person,
                c.phone AS customer_phone,
                c.email AS customer_email,
                c.gst_number AS customer_gst,
                c.billing_address,
                c.shipping_address,
                c.city,
                c.state,
                c.pincode,
                so.order_number AS sales_order_number
             FROM dispatches d
             INNER JOIN customers c ON c.id = d.customer_id
             LEFT JOIN sales_orders so ON so.id = d.sales_order_id
             WHERE d.id = ?`,
            [id]
        );

        if (dispatchRows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Dispatch record not found."
            });
        }

        const dispatch = dispatchRows[0];

        // Fetch items and roll details
        const [items] = await pool.query(
            `SELECT 
                di.*,
                cr.width_m,
                cr.thickness_mm,
                cr.gsm,
                cr.grade,
                cr.barcode,
                p.product_code,
                p.product_name,
                p.carpet_type,
                p.colour,
                p.design_pattern
             FROM dispatch_items di
             LEFT JOIN carpet_rolls cr ON cr.id = di.roll_id
             LEFT JOIN products p ON p.id = cr.product_id
             WHERE di.dispatch_id = ?
             ORDER BY di.id ASC`,
            [id]
        );

        dispatch.items = items;

        res.json({
            success: true,
            data: dispatch
        });
    } catch (error) {
        console.error("GET DISPATCH BY ID ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch dispatch details",
            error: error.message
        });
    }
};

// =========================================================
// 7. GET WAREHOUSE LOCATIONS (FOR FINISHED GOODS)
// =========================================================
const getLocations = async (req, res) => {
    try {
        const [locations] = await pool.query(
            `SELECT id, warehouse_id, location_code, location_name 
             FROM warehouse_locations 
             WHERE warehouse_id = 3
             ORDER BY location_code ASC`
        );

        res.json({
            success: true,
            data: locations
        });
    } catch (error) {
        console.error("GET LOCATIONS ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch warehouse locations",
            error: error.message
        });
    }
};

module.exports = {
    getInventorySummary,
    getKPIs,
    stockInRolls,
    createDispatch,
    getDispatches,
    getDispatchById,
    getLocations
};
