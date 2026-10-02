const pool = require("../config/database");

// =========================================================
// HELPER: GENERATE CHALLAN & GATE PASS NUMBERS
// =========================================================
async function generateChallanNumber(connection) {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const prefix = `DC-${today}-`;
    const [rows] = await connection.query(
        `SELECT challan_number FROM dispatch_challans WHERE challan_number LIKE ? ORDER BY id DESC LIMIT 1`,
        [`${prefix}%`]
    );

    let nextSeq = 1;
    if (rows.length > 0) {
        const lastNum = rows[0].challan_number;
        const parts = lastNum.split("-");
        const lastSeq = parseInt(parts[parts.length - 1], 10);
        if (!isNaN(lastSeq)) nextSeq = lastSeq + 1;
    }
    return `${prefix}${String(nextSeq).padStart(4, "0")}`;
}

async function generateGatePassNumber(connection) {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const prefix = `GP-${today}-`;
    const [rows] = await connection.query(
        `SELECT gate_pass_number FROM dispatch_challans WHERE gate_pass_number LIKE ? ORDER BY id DESC LIMIT 1`,
        [`${prefix}%`]
    );

    let nextSeq = 1;
    if (rows.length > 0) {
        const lastNum = rows[0].gate_pass_number;
        const parts = lastNum.split("-");
        const lastSeq = parseInt(parts[parts.length - 1], 10);
        if (!isNaN(lastSeq)) nextSeq = lastSeq + 1;
    }
    return `${prefix}${String(nextSeq).padStart(4, "0")}`;
}

// =========================================================
// 1. GET ALL DISPATCH CHALLANS
// =========================================================
const getChallans = async (req, res) => {
    try {
        const { search, status, from_date, to_date } = req.query;

        let query = `
            SELECT 
                dc.*,
                c.customer_code,
                c.city AS destination_city,
                c.state AS destination_state
            FROM dispatch_challans dc
            LEFT JOIN customers c ON c.id = dc.customer_id
            WHERE 1=1
        `;
        const params = [];

        if (status) {
            query += ` AND dc.status = ?`;
            params.push(status);
        }

        if (from_date) {
            query += ` AND dc.dispatch_date >= ?`;
            params.push(from_date);
        }

        if (to_date) {
            query += ` AND dc.dispatch_date <= ?`;
            params.push(to_date);
        }

        if (search) {
            query += ` AND (
                dc.challan_number LIKE ? OR 
                dc.gate_pass_number LIKE ? OR 
                dc.vehicle_number LIKE ? OR 
                dc.customer_name LIKE ? OR 
                dc.transporter_name LIKE ? OR 
                dc.lr_number LIKE ?
            )`;
            const s = `%${search.trim()}%`;
            params.push(s, s, s, s, s, s);
        }

        query += ` ORDER BY dc.id DESC`;

        const [rows] = await pool.query(query, params);

        res.json({
            success: true,
            data: rows
        });
    } catch (error) {
        console.error("GET CHALLANS ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch dispatch challans",
            error: error.message
        });
    }
};

// =========================================================
// 2. GET DISPATCH METRIC STATS
// =========================================================
const getChallanStats = async (req, res) => {
    try {
        const today = new Date().toISOString().slice(0, 10);

        const [todayStats] = await pool.query(`
            SELECT 
                COUNT(*) AS today_dispatches,
                COALESCE(SUM(total_rolls), 0) AS today_rolls,
                COALESCE(SUM(total_sqm), 0) AS today_sqm,
                COALESCE(SUM(total_net_weight_kg), 0) AS today_weight_kg
            FROM dispatch_challans
            WHERE dispatch_date = ? AND status = 'DISPATCHED'
        `, [today]);

        const [overallStats] = await pool.query(`
            SELECT 
                COUNT(CASE WHEN status IN ('PREPARING', 'LOADED') THEN 1 END) AS pending_loading,
                COUNT(CASE WHEN status = 'DISPATCHED' THEN 1 END) AS completed_dispatches,
                COALESCE(SUM(CASE WHEN status = 'DISPATCHED' THEN total_rolls ELSE 0 END), 0) AS total_dispatched_rolls,
                COALESCE(SUM(CASE WHEN status = 'DISPATCHED' THEN total_sqm ELSE 0 END), 0) AS total_dispatched_sqm,
                COUNT(DISTINCT transporter_name) AS active_transporters
            FROM dispatch_challans
        `);

        // Ready rolls in warehouse awaiting vehicle loading
        const [readyRolls] = await pool.query(`
            SELECT COUNT(*) AS ready_rolls_count, COALESCE(SUM(area_sqm), 0) AS ready_sqm
            FROM carpet_rolls
            WHERE status IN ('APPROVED', 'IN_WAREHOUSE') AND dispatch_challan_id IS NULL
        `);

        res.json({
            success: true,
            data: {
                today_dispatches: todayStats[0]?.today_dispatches || 0,
                today_rolls: Number(todayStats[0]?.today_rolls || 0),
                today_sqm: Number(todayStats[0]?.today_sqm || 0).toFixed(2),
                today_weight_kg: Number(todayStats[0]?.today_weight_kg || 0).toFixed(2),
                pending_loading: overallStats[0]?.pending_loading || 0,
                completed_dispatches: overallStats[0]?.completed_dispatches || 0,
                total_dispatched_rolls: Number(overallStats[0]?.total_dispatched_rolls || 0),
                total_dispatched_sqm: Number(overallStats[0]?.total_dispatched_sqm || 0).toFixed(2),
                active_transporters: overallStats[0]?.active_transporters || 0,
                ready_rolls_count: readyRolls[0]?.ready_rolls_count || 0,
                ready_sqm: Number(readyRolls[0]?.ready_sqm || 0).toFixed(2)
            }
        });
    } catch (error) {
        console.error("GET STATS ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to load dispatch statistics",
            error: error.message
        });
    }
};

// =========================================================
// 3. GET SINGLE CHALLAN BY ID (WITH LOADED ITEMS)
// =========================================================
const getChallanById = async (req, res) => {
    try {
        const { id } = req.params;

        const [challanRows] = await pool.query(`
            SELECT 
                dc.*,
                c.customer_code,
                c.contact_person,
                c.phone AS customer_phone,
                c.email AS customer_email,
                c.billing_address,
                c.shipping_address,
                c.city AS dest_city,
                c.state AS dest_state,
                c.pincode AS dest_pincode,
                so.order_number,
                so.order_date
            FROM dispatch_challans dc
            LEFT JOIN customers c ON c.id = dc.customer_id
            LEFT JOIN sales_orders so ON so.id = dc.sales_order_id
            WHERE dc.id = ?
            LIMIT 1
        `, [id]);

        if (challanRows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Dispatch Challan not found"
            });
        }

        const challan = challanRows[0];

        // Fetch loaded rolls
        const [items] = await pool.query(`
            SELECT 
                dci.*,
                cr.thickness_mm,
                cr.gsm,
                cr.warehouse_location
            FROM dispatch_challan_items dci
            LEFT JOIN carpet_rolls cr ON cr.id = dci.carpet_roll_id
            WHERE dci.challan_id = ?
            ORDER BY dci.id ASC
        `, [id]);

        res.json({
            success: true,
            data: {
                ...challan,
                items
            }
        });
    } catch (error) {
        console.error("GET CHALLAN BY ID ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch challan details",
            error: error.message
        });
    }
};

// =========================================================
// 4. GET READY ROLLS IN WAREHOUSE AWAITING DISPATCH
// =========================================================
const getReadyRolls = async (req, res) => {
    try {
        const [rolls] = await pool.query(`
            SELECT 
                cr.*,
                p.product_code,
                p.product_name,
                p.carpet_type,
                p.design_pattern,
                p.colour,
                po.production_order_number
            FROM carpet_rolls cr
            INNER JOIN products p ON p.id = cr.product_id
            LEFT JOIN production_orders po ON po.id = cr.production_order_id
            WHERE cr.status IN ('APPROVED', 'IN_WAREHOUSE')
              AND cr.dispatch_challan_id IS NULL
            ORDER BY cr.id DESC
        `);

        res.json({
            success: true,
            data: rolls
        });
    } catch (error) {
        console.error("GET READY ROLLS ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch ready rolls",
            error: error.message
        });
    }
};

// =========================================================
// 5. CREATE NEW DISPATCH CHALLAN & LOAD ROLLS
// =========================================================
const createChallan = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const {
            customer_id,
            customer_name,
            consignee_name,
            delivery_address,
            customer_gst,
            sales_order_id,
            sales_order_number,
            transporter_name,
            vehicle_number,
            driver_name,
            driver_phone,
            driver_license,
            lr_number,
            lr_date,
            eway_bill_number,
            dispatch_date = new Date().toISOString().slice(0, 10),
            dispatch_time = new Date().toTimeString().slice(0, 8),
            roll_ids = [],
            remarks,
            created_by = "Dispatch Incharge",
            auto_dispatch = false
        } = req.body;

        if (!vehicle_number) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "Vehicle registration number is required."
            });
        }

        let custName = customer_name || consignee_name;
        if (!custName && customer_id) {
            const [cRows] = await connection.query("SELECT company_name FROM customers WHERE id = ? LIMIT 1", [customer_id]);
            if (cRows.length > 0) {
                custName = cRows[0].company_name;
            }
        }

        if (!custName) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "Customer / Consignee name is required."
            });
        }

        const rollsToLoad = (roll_ids && roll_ids.length > 0) ? roll_ids : (req.body.loaded_rolls || []);

        if (!rollsToLoad || rollsToLoad.length === 0) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "Please select at least one Carpet Roll to load on this vehicle."
            });
        }

        // Fetch roll data
        const [rolls] = await connection.query(`
            SELECT 
                cr.*,
                p.product_code,
                p.product_name,
                p.carpet_type,
                p.colour
            FROM carpet_rolls cr
            INNER JOIN products p ON p.id = cr.product_id
            WHERE cr.id IN (?)
        `, [rollsToLoad]);

        if (rolls.length === 0) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "Selected rolls not found in database."
            });
        }

        // Calculate aggregates
        let totalLinearMeters = 0;
        let totalSqm = 0;
        let totalNetWeight = 0;
        let totalGrossWeight = 0;

        for (const r of rolls) {
            totalLinearMeters += parseFloat(r.length_m || 0);
            totalSqm += parseFloat(r.area_sqm || (parseFloat(r.width_m) * parseFloat(r.length_m)) || 0);
            totalNetWeight += parseFloat(r.net_weight_kg || 0);
            totalGrossWeight += parseFloat(r.gross_weight_kg || (parseFloat(r.net_weight_kg) + parseFloat(r.core_weight_kg || 2.5)) || 0);
        }

        const challan_number = await generateChallanNumber(connection);
        const gate_pass_number = await generateGatePassNumber(connection);
        const initialStatus = auto_dispatch ? "DISPATCHED" : "LOADED";

        // Insert Challan Header
        const [challanResult] = await connection.query(`
            INSERT INTO dispatch_challans (
                challan_number, gate_pass_number, customer_id, customer_name, consignee_name,
                delivery_address, customer_gst, sales_order_id, sales_order_number,
                transporter_name, vehicle_number, driver_name, driver_phone, driver_license,
                lr_number, lr_date, eway_bill_number, dispatch_date, dispatch_time,
                total_rolls, total_linear_meters, total_sqm, total_net_weight_kg, total_gross_weight_kg,
                status, created_by, remarks
            ) VALUES (
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?, ?
            )
        `, [
            challan_number, gate_pass_number, customer_id || null, custName, consignee_name || custName,
            delivery_address || "", customer_gst || "", sales_order_id || null, sales_order_number || "",
            transporter_name || "Self / Customer Fleet", vehicle_number.toUpperCase().trim(), driver_name || "", driver_phone || "", driver_license || "",
            lr_number || "", lr_date || null, eway_bill_number || "", dispatch_date, dispatch_time,
            rolls.length, totalLinearMeters.toFixed(2), totalSqm.toFixed(2), totalNetWeight.toFixed(2), totalGrossWeight.toFixed(2),
            initialStatus, created_by, remarks || ""
        ]);

        const challanId = challanResult.insertId;

        // Insert Manifest Items
        for (const r of rolls) {
            const itemArea = parseFloat(r.area_sqm || (parseFloat(r.width_m) * parseFloat(r.length_m)) || 0);
            const itemNet = parseFloat(r.net_weight_kg || 0);
            const itemGross = parseFloat(r.gross_weight_kg || (itemNet + parseFloat(r.core_weight_kg || 2.5)));

            await connection.query(`
                INSERT INTO dispatch_challan_items (
                    challan_id, carpet_roll_id, roll_number, product_id, product_name,
                    product_code, carpet_type, color, width_m, length_m,
                    area_sqm, net_weight_kg, gross_weight_kg, grade
                ) VALUES (
                    ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?,
                    ?, ?, ?, ?
                )
            `, [
                challanId, r.id, r.roll_number, r.product_id, r.product_name,
                r.product_code || "", r.carpet_type || "", r.colour || "", r.width_m, r.length_m,
                itemArea, itemNet, itemGross, r.grade || "GRADE_A"
            ]);

            // Update Roll Status
            await connection.query(`
                UPDATE carpet_rolls 
                SET dispatch_challan_id = ?,
                    status = ?,
                    dispatched_at = ?
                WHERE id = ?
            `, [
                challanId,
                auto_dispatch ? "DISPATCHED" : "IN_WAREHOUSE",
                auto_dispatch ? new Date() : null,
                r.id
            ]);
        }

        await connection.commit();

        res.status(201).json({
            success: true,
            message: `Delivery Challan ${challan_number} and Outward Gate Pass ${gate_pass_number} created successfully!`,
            data: {
                id: challanId,
                challan_number,
                gate_pass_number,
                total_rolls: rolls.length,
                total_sqm: totalSqm.toFixed(2),
                status: initialStatus
            }
        });
    } catch (error) {
        await connection.rollback();
        console.error("CREATE CHALLAN ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to create dispatch challan",
            error: error.message
        });
    } finally {
        connection.release();
    }
};

// =========================================================
// 6. CONFIRM GATE OUT & MARK AS DISPATCHED
// =========================================================
const confirmDispatch = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const { id } = req.params;
        const { security_officer_name = "Main Gate Security", remarks } = req.body;

        const [challanRows] = await connection.query(
            `SELECT id, challan_number, gate_pass_number, status FROM dispatch_challans WHERE id = ?`,
            [id]
        );

        if (challanRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({
                success: false,
                message: "Challan not found"
            });
        }

        const challan = challanRows[0];
        if (challan.status === "DISPATCHED") {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "Challan is already marked as Dispatched."
            });
        }

        // Update Challan to DISPATCHED
        await connection.query(`
            UPDATE dispatch_challans 
            SET status = 'DISPATCHED',
                dispatch_time = NOW(),
                security_officer_name = ?,
                remarks = COALESCE(?, remarks)
            WHERE id = ?
        `, [security_officer_name, remarks, id]);

        // Update all associated rolls to DISPATCHED
        await connection.query(`
            UPDATE carpet_rolls 
            SET status = 'DISPATCHED',
                dispatched_at = NOW()
            WHERE dispatch_challan_id = ?
        `, [id]);

        await connection.commit();

        res.json({
            success: true,
            message: `Vehicle Gate Out confirmed! Challan ${challan.challan_number} is officially Dispatched.`,
            data: {
                id,
                status: "DISPATCHED"
            }
        });
    } catch (error) {
        await connection.rollback();
        console.error("CONFIRM DISPATCH ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to confirm vehicle dispatch",
            error: error.message
        });
    } finally {
        connection.release();
    }
};

// =========================================================
// 7. CANCEL CHALLAN & RELEASE ROLLS
// =========================================================
const cancelChallan = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const { id } = req.params;

        const [challanRows] = await connection.query(
            `SELECT id, challan_number, status FROM dispatch_challans WHERE id = ?`,
            [id]
        );

        if (challanRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({
                success: false,
                message: "Challan not found"
            });
        }

        // Release rolls
        await connection.query(`
            UPDATE carpet_rolls 
            SET dispatch_challan_id = NULL,
                status = 'IN_WAREHOUSE'
            WHERE dispatch_challan_id = ?
        `, [id]);

        // Mark challan cancelled
        await connection.query(`
            UPDATE dispatch_challans 
            SET status = 'CANCELLED' 
            WHERE id = ?
        `, [id]);

        await connection.commit();

        res.json({
            success: true,
            message: `Dispatch Challan cancelled. All rolls released back to warehouse stock.`
        });
    } catch (error) {
        await connection.rollback();
        console.error("CANCEL CHALLAN ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to cancel challan",
            error: error.message
        });
    } finally {
        connection.release();
    }
};

module.exports = {
    getChallans,
    getChallanStats,
    getChallanById,
    getReadyRolls,
    createChallan,
    confirmDispatch,
    cancelChallan
};
