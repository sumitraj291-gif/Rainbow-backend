const pool = require("../config/database");

/**
 * 1. GET STOCK TRANSACTIONS / AUDIT LEDGER
 */
const getStockTransactions = async (req, res) => {
    try {
        const { type = "", search = "", from_date = "", to_date = "" } = req.query;

        let query = `
            SELECT 
                st.id,
                st.transaction_type,
                st.reference_type,
                st.reference_id,
                st.quantity,
                st.transaction_date,
                st.remarks,
                st.created_at,
                
                -- Material details
                rm.material_code,
                rm.material_name,
                
                -- Product details
                p.product_code,
                p.product_name,
                
                -- Batch details
                mb.batch_number,
                
                -- Warehouse & location
                w.warehouse_name,
                wl.location_name

            FROM stock_transactions st
            LEFT JOIN raw_materials rm ON rm.id = st.material_id
            LEFT JOIN products p ON p.id = st.product_id
            LEFT JOIN material_batches mb ON mb.id = st.batch_id
            LEFT JOIN warehouses w ON w.id = st.warehouse_id
            LEFT JOIN warehouse_locations wl ON wl.id = st.location_id
            WHERE 1=1
        `;
        const params = [];

        if (type && type !== "ALL") {
            query += ` AND st.transaction_type = ?`;
            params.push(type);
        }

        if (from_date) {
            query += ` AND DATE(st.transaction_date) >= ?`;
            params.push(from_date);
        }

        if (to_date) {
            query += ` AND DATE(st.transaction_date) <= ?`;
            params.push(to_date);
        }

        if (search.trim()) {
            query += ` AND (
                rm.material_code LIKE ? OR 
                rm.material_name LIKE ? OR 
                p.product_code LIKE ? OR 
                p.product_name LIKE ? OR 
                mb.batch_number LIKE ? OR 
                st.remarks LIKE ?
            )`;
            const term = `%${search.trim()}%`;
            params.push(term, term, term, term, term, term);
        }

        query += ` ORDER BY st.id DESC LIMIT 100`;

        const [rows] = await pool.query(query, params);

        // Stats summary
        const [statsRows] = await pool.query(`
            SELECT 
                COUNT(*) AS total_transactions,
                COUNT(CASE WHEN transaction_type = 'IN' THEN 1 END) AS in_count,
                COUNT(CASE WHEN transaction_type = 'OUT' THEN 1 END) AS out_count,
                COUNT(CASE WHEN transaction_type = 'ADJUSTMENT' THEN 1 END) AS adj_count
            FROM stock_transactions
        `);

        res.json({
            success: true,
            data: rows,
            stats: statsRows[0] || { total_transactions: rows.length, in_count: 0, out_count: 0, adj_count: 0 }
        });
    } catch (error) {
        console.error("Get Stock Transactions Error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch stock transactions",
            error: error.message
        });
    }
};

/**
 * 2. GET WORK IN PROGRESS (WIP) ACTIVE BATCHES & SHOPFLOOR STAGES
 */
const getWIPStatus = async (req, res) => {
    try {
        // Active orders currently in WIP
        const [orders] = await pool.query(`
            SELECT 
                po.id,
                po.production_order_number,
                po.planned_quantity,
                po.target_quantity,
                po.production_date,
                po.status AS order_status,
                po.priority,
                p.product_code,
                p.product_name,
                p.carpet_type,
                p.colour,
                u.symbol AS unit_symbol
            FROM production_orders po
            INNER JOIN products p ON p.id = po.product_id
            LEFT JOIN units u ON u.id = p.unit_id
            WHERE po.status IN ('PLANNED', 'IN_PROGRESS', 'RUNNING', 'QC_PENDING')
            ORDER BY po.id DESC
        `);

        // Get running stage for each active order
        const wipBatches = [];
        for (const order of orders) {
            const [processes] = await pool.query(`
                SELECT 
                    pop.id,
                    pop.sequence_no,
                    pop.process_status,
                    pop.planned_quantity,
                    pop.input_quantity,
                    pop.good_quantity,
                    pop.rejected_quantity,
                    pop.start_time,
                    pr.process_code,
                    pr.process_name,
                    pr.department,
                    m.machine_code,
                    m.machine_name
                FROM production_order_processes pop
                INNER JOIN product_processes pp ON pp.id = pop.product_process_id
                INNER JOIN processes pr ON pr.id = pp.process_id
                LEFT JOIN machines m ON m.id = pop.machine_id
                WHERE pop.production_order_id = ?
                ORDER BY pop.sequence_no ASC
            `, [order.id]);

            const currentRunning = processes.find(p => p.process_status === 'RUNNING') 
                || processes.find(p => p.process_status === 'PENDING')
                || processes[processes.length - 1];

            const completedCount = processes.filter(p => p.process_status === 'COMPLETED').length;
            const progressPct = processes.length > 0 ? Math.round((completedCount / processes.length) * 100) : 0;

            wipBatches.push({
                ...order,
                total_stages: processes.length,
                completed_stages: completedCount,
                progress_percentage: progressPct,
                current_process: currentRunning ? currentRunning.process_name : "Not Started",
                current_machine: currentRunning?.machine_name || "—",
                current_stage_status: currentRunning?.process_status || "PENDING",
                stages: processes
            });
        }

        // Active paste mixing batches in WIP
        const [pasteBatches] = await pool.query(`
            SELECT 
                pmb.*,
                cf.formulation_name,
                cf.formulation_type
            FROM paste_mixing_batches pmb
            LEFT JOIN chemical_formulations cf ON cf.id = pmb.formulation_id
            WHERE pmb.status IN ('MIXING', 'DEAERATION', 'READY_FOR_USE')
            ORDER BY pmb.id DESC
        `);

        res.json({
            success: true,
            data: {
                active_orders: wipBatches,
                active_paste_mixes: pasteBatches,
                kpis: {
                    total_wip_orders: wipBatches.length,
                    total_wip_quantity: wipBatches.reduce((sum, o) => sum + Number(o.target_quantity || 0), 0),
                    active_mix_batches: pasteBatches.length
                }
            }
        });
    } catch (error) {
        console.error("Get WIP Status Error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch WIP status",
            error: error.message
        });
    }
};

/**
 * 3. GET PRODUCTION REPORT (Summary by Shift, Machine, Product)
 */
const getProductionReport = async (req, res) => {
    try {
        const { from_date, to_date } = req.query;

        let dateCondition = "1=1";
        const params = [];
        if (from_date) {
            dateCondition += " AND pe.production_date >= ?";
            params.push(from_date);
        }
        if (to_date) {
            dateCondition += " AND pe.production_date <= ?";
            params.push(to_date);
        }

        // By Product
        const [byProduct] = await pool.query(`
            SELECT 
                p.product_code,
                p.product_name,
                p.carpet_type,
                u.symbol AS unit,
                COUNT(pe.id) AS total_entries,
                COALESCE(SUM(pe.input_quantity), 0) AS total_input,
                COALESCE(SUM(pe.good_quantity), 0) AS total_good,
                COALESCE(SUM(pe.rejected_quantity), 0) AS total_rejected,
                COALESCE(SUM(pe.wastage_quantity), 0) AS total_wastage,
                COALESCE(SUM(pe.downtime_minutes), 0) AS total_downtime
            FROM products p
            LEFT JOIN production_orders po ON po.product_id = p.id
            LEFT JOIN production_entries pe ON pe.production_order_id = po.id AND ${dateCondition}
            LEFT JOIN units u ON u.id = p.unit_id
            GROUP BY p.id
            ORDER BY total_good DESC
        `, params);

        // By Machine
        const [byMachine] = await pool.query(`
            SELECT 
                m.machine_code,
                m.machine_name,
                m.machine_type,
                COUNT(pe.id) AS total_runs,
                COALESCE(SUM(pe.good_quantity), 0) AS total_output,
                COALESCE(SUM(pe.downtime_minutes), 0) AS total_downtime
            FROM machines m
            LEFT JOIN production_entries pe ON pe.machine_id = m.id AND ${dateCondition}
            GROUP BY m.id
            ORDER BY total_output DESC
        `, params);

        // By Shift
        const [byShift] = await pool.query(`
            SELECT 
                COALESCE(pe.shift, 'DAY') AS shift_name,
                COUNT(pe.id) AS total_runs,
                COALESCE(SUM(pe.good_quantity), 0) AS total_good,
                COALESCE(SUM(pe.rejected_quantity), 0) AS total_rejected,
                COALESCE(SUM(pe.downtime_minutes), 0) AS total_downtime
            FROM production_entries pe
            WHERE ${dateCondition}
            GROUP BY pe.shift
        `, params);

        res.json({
            success: true,
            data: {
                by_product: byProduct,
                by_machine: byMachine,
                by_shift: byShift
            }
        });
    } catch (error) {
        console.error("Get Production Report Error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to generate production report",
            error: error.message
        });
    }
};

/**
 * 4. GET QUALITY REPORT (First Pass Yield, Scrap Breakdown, Roll QC Status)
 */
const getQualityReport = async (req, res) => {
    try {
        const [rollQC] = await pool.query(`
            SELECT 
                status,
                grade,
                COUNT(*) AS count,
                COALESCE(SUM(length_m), 0) AS total_meters,
                COALESCE(SUM(net_weight_kg), 0) AS total_kg
            FROM carpet_rolls
            GROUP BY status, grade
        `);

        const [inspectionLogs] = await pool.query(`
            SELECT 
                cri.id,
                cri.inspection_number,
                cri.inspection_date,
                cri.actual_gsm,
                cri.avg_thickness_mm,
                cri.visual_defects_notes,
                cri.overall_result,
                cri.assigned_grade,
                cr.roll_number,
                p.product_name
            FROM carpet_roll_inspections cri
            INNER JOIN carpet_rolls cr ON cr.id = cri.roll_id
            INNER JOIN products p ON p.id = cr.product_id
            ORDER BY cri.id DESC
            LIMIT 20
        `);

        const [kpis] = await pool.query(`
            SELECT 
                COUNT(*) AS total_rolls_inspected,
                COUNT(CASE WHEN grade = 'A' OR status = 'APPROVED' THEN 1 END) AS approved_rolls,
                COUNT(CASE WHEN grade = 'REJECTED' OR status = 'REJECTED' THEN 1 END) AS rejected_rolls,
                COUNT(CASE WHEN grade = 'B' OR status = 'GRADE_B' THEN 1 END) AS grade_b_rolls
            FROM carpet_rolls
        `);

        const total = kpis[0]?.total_rolls_inspected || 0;
        const approved = kpis[0]?.approved_rolls || 0;
        const fpy = total > 0 ? Number(((approved / total) * 100).toFixed(1)) : 100;

        res.json({
            success: true,
            data: {
                kpis: {
                    total_inspected: total,
                    approved_rolls: approved,
                    rejected_rolls: kpis[0]?.rejected_rolls || 0,
                    grade_b_rolls: kpis[0]?.grade_b_rolls || 0,
                    first_pass_yield_pct: fpy
                },
                roll_summary: rollQC,
                recent_inspections: inspectionLogs
            }
        });
    } catch (error) {
        console.error("Get Quality Report Error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to generate quality report",
            error: error.message
        });
    }
};

/**
 * 5. GET INVENTORY VALUATION & STOCK REPORT
 */
const getInventoryReport = async (req, res) => {
    try {
        // Raw Material Stock
        const [rawMaterials] = await pool.query(`
            SELECT 
                mc.name AS category_name,
                COUNT(rm.id) AS item_count,
                COALESCE(SUM(mb.current_quantity), 0) AS total_qty,
                COALESCE(SUM(mb.current_quantity * rm.standard_purchase_rate), 0) AS total_valuation_inr
            FROM raw_materials rm
            LEFT JOIN material_categories mc ON mc.id = rm.category_id
            LEFT JOIN material_batches mb ON mb.material_id = rm.id AND mb.qc_status = 'APPROVED'
            GROUP BY mc.id
        `);

        // Finished Goods Stock
        const [finishedGoods] = await pool.query(`
            SELECT 
                p.product_code,
                p.product_name,
                p.carpet_type,
                u.symbol AS unit,
                COALESCE(SUM(fg.quantity_available), 0) AS available_stock,
                COALESCE(SUM(fg.quantity_available * p.selling_price), 0) AS estimated_stock_value_inr
            FROM products p
            LEFT JOIN finished_goods fg ON fg.product_id = p.id
            LEFT JOIN units u ON u.id = p.unit_id
            GROUP BY p.id
            ORDER BY available_stock DESC
        `);

        const totalRawVal = rawMaterials.reduce((sum, r) => sum + Number(r.total_valuation_inr || 0), 0);
        const totalFGVal = finishedGoods.reduce((sum, f) => sum + Number(f.estimated_stock_value_inr || 0), 0);

        res.json({
            success: true,
            data: {
                raw_materials: rawMaterials,
                finished_goods: finishedGoods,
                kpis: {
                    raw_material_valuation_inr: totalRawVal,
                    finished_goods_valuation_inr: totalFGVal,
                    total_plant_valuation_inr: totalRawVal + totalFGVal
                }
            }
        });
    } catch (error) {
        console.error("Get Inventory Report Error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to generate inventory report",
            error: error.message
        });
    }
};

module.exports = {
    getStockTransactions,
    getWIPStatus,
    getProductionReport,
    getQualityReport,
    getInventoryReport
};
