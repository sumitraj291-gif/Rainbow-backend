const pool = require("../config/database");

// =========================================================
// HELPER: GENERATE TICKET & WORK ORDER NUMBERS
// =========================================================
async function generateBreakdownNumber(connection) {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const prefix = `BD-${today}-`;
    const [rows] = await connection.query(
        `SELECT breakdown_ticket_no FROM machine_breakdowns WHERE breakdown_ticket_no LIKE ? ORDER BY id DESC LIMIT 1`,
        [`${prefix}%`]
    );

    let nextSeq = 1;
    if (rows.length > 0 && rows[0].breakdown_ticket_no) {
        const parts = rows[0].breakdown_ticket_no.split("-");
        const lastSeq = parseInt(parts[parts.length - 1], 10);
        if (!isNaN(lastSeq)) nextSeq = lastSeq + 1;
    }
    return `${prefix}${String(nextSeq).padStart(4, "0")}`;
}

async function generateWorkOrderNumber(connection) {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const prefix = `WO-${today}-`;
    const [rows] = await connection.query(
        `SELECT work_order_no FROM machine_maintenance WHERE work_order_no LIKE ? ORDER BY id DESC LIMIT 1`,
        [`${prefix}%`]
    );

    let nextSeq = 1;
    if (rows.length > 0 && rows[0].work_order_no) {
        const parts = rows[0].work_order_no.split("-");
        const lastSeq = parseInt(parts[parts.length - 1], 10);
        if (!isNaN(lastSeq)) nextSeq = lastSeq + 1;
    }
    return `${prefix}${String(nextSeq).padStart(4, "0")}`;
}

// =========================================================
// 1. GET MAINTENANCE & PLANT RELIABILITY METRICS
// =========================================================
const getMaintenanceStats = async (req, res) => {
    try {
        const [machineStats] = await pool.query(`
            SELECT 
                COUNT(*) AS total_machines,
                COUNT(CASE WHEN status = 'RUNNING' THEN 1 END) AS running_machines,
                COUNT(CASE WHEN status = 'BREAKDOWN' THEN 1 END) AS breakdown_machines,
                COUNT(CASE WHEN status = 'MAINTENANCE' THEN 1 END) AS maintenance_machines,
                COUNT(CASE WHEN status = 'IDLE' THEN 1 END) AS idle_machines
            FROM machines
        `);

        const [breakdownStats] = await pool.query(`
            SELECT 
                COUNT(CASE WHEN status IN ('OPEN', 'IN_REPAIR') THEN 1 END) AS active_breakdowns_count,
                COUNT(*) AS total_breakdowns,
                COALESCE(SUM(downtime_minutes), 0) AS total_downtime_minutes,
                COALESCE(AVG(downtime_minutes), 0) AS mttr_minutes
            FROM machine_breakdowns
        `);

        const [pmStats] = await pool.query(`
            SELECT 
                COUNT(CASE WHEN status IN ('SCHEDULED', 'IN_PROGRESS') THEN 1 END) AS upcoming_pm_count,
                COALESCE(SUM(cost), 0) AS total_pm_cost_inr
            FROM machine_maintenance
        `);

        const totalM = machineStats[0]?.total_machines || 1;
        const runningM = machineStats[0]?.running_machines || 0;
        const plantAvailabilityPct = ((runningM / totalM) * 100).toFixed(1);

        res.json({
            success: true,
            data: {
                total_machines: totalM,
                running_machines: runningM,
                breakdown_machines: machineStats[0]?.breakdown_machines || 0,
                maintenance_machines: machineStats[0]?.maintenance_machines || 0,
                idle_machines: machineStats[0]?.idle_machines || 0,
                plant_availability_pct: plantAvailabilityPct,
                active_breakdowns_count: breakdownStats[0]?.active_breakdowns_count || 0,
                total_breakdowns: breakdownStats[0]?.total_breakdowns || 0,
                total_downtime_minutes: Number(breakdownStats[0]?.total_downtime_minutes || 0),
                mttr_minutes: Math.round(Number(breakdownStats[0]?.mttr_minutes || 0)),
                upcoming_pm_count: pmStats[0]?.upcoming_pm_count || 0,
                total_pm_cost_inr: Number(pmStats[0]?.total_pm_cost_inr || 0).toFixed(2)
            }
        });
    } catch (error) {
        console.error("GET MAINTENANCE STATS ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to load maintenance statistics",
            error: error.message
        });
    }
};

// =========================================================
// 2. GET MACHINES LIST WITH BREAKDOWN SUMMARY
// =========================================================
const getMachinesList = async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT 
                m.*,
                COALESCE(bd.open_breakdowns, 0) AS open_breakdowns,
                COALESCE(bd.total_downtime, 0) AS total_downtime_minutes,
                COALESCE(pm.active_pm_count, 0) AS active_pm_count
            FROM machines m
            LEFT JOIN (
                SELECT 
                    machine_id, 
                    COUNT(CASE WHEN status IN ('OPEN', 'IN_REPAIR') THEN 1 END) AS open_breakdowns,
                    SUM(downtime_minutes) AS total_downtime
                FROM machine_breakdowns 
                GROUP BY machine_id
            ) bd ON bd.machine_id = m.id
            LEFT JOIN (
                SELECT 
                    machine_id,
                    COUNT(*) AS active_pm_count
                FROM machine_maintenance
                WHERE status IN ('SCHEDULED', 'IN_PROGRESS')
                GROUP BY machine_id
            ) pm ON pm.machine_id = m.id
            ORDER BY m.id ASC
        `);

        res.json({
            success: true,
            data: rows
        });
    } catch (error) {
        console.error("GET MACHINES LIST ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch machines",
            error: error.message
        });
    }
};

// =========================================================
// 3. GET BREAKDOWN TICKETS
// =========================================================
const getBreakdowns = async (req, res) => {
    try {
        const { machine_id, status, severity, search } = req.query;

        let query = `
            SELECT 
                mb.*,
                m.machine_code,
                m.machine_name,
                m.machine_type
            FROM machine_breakdowns mb
            INNER JOIN machines m ON m.id = mb.machine_id
            WHERE 1=1
        `;
        const params = [];

        if (machine_id) {
            query += ` AND mb.machine_id = ?`;
            params.push(machine_id);
        }

        if (status) {
            query += ` AND mb.status = ?`;
            params.push(status);
        }

        if (severity) {
            query += ` AND mb.severity = ?`;
            params.push(severity);
        }

        if (search) {
            query += ` AND (
                mb.breakdown_ticket_no LIKE ? OR 
                mb.reason LIKE ? OR 
                mb.root_cause_category LIKE ? OR 
                mb.technician_name LIKE ? OR
                m.machine_name LIKE ?
            )`;
            const s = `%${search.trim()}%`;
            params.push(s, s, s, s, s);
        }

        query += ` ORDER BY mb.id DESC`;

        const [rows] = await pool.query(query, params);

        res.json({
            success: true,
            data: rows
        });
    } catch (error) {
        console.error("GET BREAKDOWNS ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch machine breakdowns",
            error: error.message
        });
    }
};

// =========================================================
// 4. REPORT NEW MACHINE BREAKDOWN TICKET
// =========================================================
const reportBreakdown = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const {
            machine_id,
            severity = "MEDIUM",
            breakdown_category = "MECHANICAL",
            reason,
            root_cause_category,
            reported_by_name = "Line Incharge",
            technician_name,
            breakdown_start = new Date().toISOString().slice(0, 19).replace("T", " ")
        } = req.body;

        if (!machine_id) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "Please select the affected machine."
            });
        }

        const breakdownReason = reason || req.body.problem_description || req.body.description;

        if (!breakdownReason) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "Breakdown symptoms / reason must be specified."
            });
        }

        const ticket_no = await generateBreakdownNumber(connection);

        // Insert Breakdown Ticket
        const [insertResult] = await connection.query(`
            INSERT INTO machine_breakdowns (
                breakdown_ticket_no, machine_id, severity, breakdown_category,
                breakdown_start, reason, root_cause_category, reported_by_name,
                technician_name, status
            ) VALUES (
                ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, 'OPEN'
            )
        `, [
            ticket_no, machine_id, severity, breakdown_category,
            breakdown_start, breakdownReason, root_cause_category || null, reported_by_name,
            technician_name || null
        ]);

        // Update Machine Status to BREAKDOWN
        await connection.query(`
            UPDATE machines SET status = 'BREAKDOWN' WHERE id = ?
        `, [machine_id]);

        await connection.commit();

        res.status(201).json({
            success: true,
            message: `Breakdown ticket ${ticket_no} logged. Machine marked as BREAKDOWN.`,
            data: {
                id: insertResult.insertId,
                breakdown_ticket_no: ticket_no
            }
        });
    } catch (error) {
        await connection.rollback();
        console.error("REPORT BREAKDOWN ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to log breakdown ticket",
            error: error.message
        });
    } finally {
        connection.release();
    }
};

// =========================================================
// 5. RESOLVE BREAKDOWN & RESUME MACHINE
// =========================================================
const resolveBreakdown = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const { id } = req.params;
        const {
            action_taken,
            root_cause_category,
            technician_name,
            spare_parts_used,
            downtime_minutes,
            breakdown_end = new Date().toISOString().slice(0, 19).replace("T", " ")
        } = req.body;

        const [existing] = await connection.query(
            `SELECT * FROM machine_breakdowns WHERE id = ?`,
            [id]
        );

        if (existing.length === 0) {
            await connection.rollback();
            return res.status(404).json({
                success: false,
                message: "Breakdown ticket not found."
            });
        }

        const ticket = existing[0];

        // Calculate downtime if not explicitly provided
        let calcMinutes = parseInt(downtime_minutes, 10);
        if (isNaN(calcMinutes) || calcMinutes <= 0) {
            const start = new Date(ticket.breakdown_start);
            const end = new Date(breakdown_end);
            calcMinutes = Math.max(15, Math.round((end - start) / (1000 * 60)));
        }

        // Update breakdown
        await connection.query(`
            UPDATE machine_breakdowns 
            SET breakdown_end = ?,
                downtime_minutes = ?,
                action_taken = ?,
                root_cause_category = COALESCE(?, root_cause_category),
                technician_name = COALESCE(?, technician_name),
                spare_parts_used = ?,
                status = 'RESOLVED'
            WHERE id = ?
        `, [
            breakdown_end, calcMinutes, action_taken || "Repairs completed and line tested.",
            root_cause_category, technician_name, spare_parts_used || "None", id
        ]);

        // Check if machine has any other OPEN breakdowns before setting to RUNNING
        const [otherOpen] = await connection.query(`
            SELECT id FROM machine_breakdowns WHERE machine_id = ? AND status IN ('OPEN', 'IN_REPAIR') AND id != ?
        `, [ticket.machine_id, id]);

        if (otherOpen.length === 0) {
            await connection.query(`
                UPDATE machines SET status = 'RUNNING' WHERE id = ?
            `, [ticket.machine_id]);
        }

        await connection.commit();

        res.json({
            success: true,
            message: `Breakdown ticket resolved! Total downtime logged: ${calcMinutes} minutes. Machine resumed.`
        });
    } catch (error) {
        await connection.rollback();
        console.error("RESOLVE BREAKDOWN ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to resolve breakdown ticket",
            error: error.message
        });
    } finally {
        connection.release();
    }
};

// =========================================================
// 6. GET PREVENTIVE MAINTENANCE WORK ORDERS
// =========================================================
const getWorkOrders = async (req, res) => {
    try {
        const { machine_id, status } = req.query;

        let query = `
            SELECT 
                mm.*,
                m.machine_code,
                m.machine_name,
                m.machine_type
            FROM machine_maintenance mm
            INNER JOIN machines m ON m.id = mm.machine_id
            WHERE 1=1
        `;
        const params = [];

        if (machine_id) {
            query += ` AND mm.machine_id = ?`;
            params.push(machine_id);
        }

        if (status) {
            query += ` AND mm.status = ?`;
            params.push(status);
        }

        query += ` ORDER BY mm.id DESC`;

        const [rows] = await pool.query(query, params);

        res.json({
            success: true,
            data: rows
        });
    } catch (error) {
        console.error("GET WORK ORDERS ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch work orders",
            error: error.message
        });
    }
};

// =========================================================
// 7. CREATE PREVENTIVE MAINTENANCE WORK ORDER
// =========================================================
const createWorkOrder = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const {
            machine_id,
            maintenance_type = "PREVENTIVE",
            priority = "NORMAL",
            frequency = "MONTHLY",
            scheduled_date = new Date().toISOString().slice(0, 10),
            description,
            checklist_items,
            cost = 0,
            downtime_hours = 1.0,
            technician_name
        } = req.body;

        if (!machine_id) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "Please select target machine."
            });
        }

        if (!description) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "Maintenance description is required."
            });
        }

        const work_order_no = await generateWorkOrderNumber(connection);

        const [insertResult] = await connection.query(`
            INSERT INTO machine_maintenance (
                work_order_no, machine_id, maintenance_type, priority, frequency,
                scheduled_date, description, checklist_items, cost, downtime_hours,
                technician_name, status
            ) VALUES (
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?,
                ?, 'SCHEDULED'
            )
        `, [
            work_order_no, machine_id, maintenance_type, priority, frequency,
            scheduled_date, description, checklist_items || "", cost, downtime_hours,
            technician_name || "Plant Maintenance Team"
        ]);

        await connection.commit();

        res.status(201).json({
            success: true,
            message: `Work Order ${work_order_no} scheduled successfully!`,
            data: {
                id: insertResult.insertId,
                work_order_no
            }
        });
    } catch (error) {
        await connection.rollback();
        console.error("CREATE WORK ORDER ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to schedule work order",
            error: error.message
        });
    } finally {
        connection.release();
    }
};

// =========================================================
// 8. COMPLETE PM WORK ORDER
// =========================================================
const completeWorkOrder = async (req, res) => {
    try {
        const { id } = req.params;
        const { actual_cost, completion_notes, technician_name } = req.body;

        await pool.query(`
            UPDATE machine_maintenance 
            SET status = 'COMPLETED',
                completed_date = NOW(),
                cost = COALESCE(?, cost),
                technician_name = COALESCE(?, technician_name)
            WHERE id = ?
        `, [actual_cost, technician_name, id]);

        res.json({
            success: true,
            message: "Preventive maintenance work order marked as completed."
        });
    } catch (error) {
        console.error("COMPLETE WORK ORDER ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to complete work order",
            error: error.message
        });
    }
};

module.exports = {
    getMaintenanceStats,
    getMachinesList,
    getBreakdowns,
    reportBreakdown,
    resolveBreakdown,
    getWorkOrders,
    createWorkOrder,
    completeWorkOrder
};
