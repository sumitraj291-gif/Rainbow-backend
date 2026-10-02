const pool = require("../config/database");

const getDashboardOverview = async (req, res) => {
    try {
        // 1. KPI Aggregation
        const [kpiRows] = await pool.query(`
            SELECT
                -- Active production orders
                (
                    SELECT COUNT(*)
                    FROM production_orders
                    WHERE status NOT IN ('COMPLETED', 'CANCELLED')
                ) AS active_orders,

                -- Total planned quantity of active orders or orders for today
                COALESCE((
                    SELECT SUM(po.target_quantity)
                    FROM production_orders po
                    WHERE po.status NOT IN ('CANCELLED')
                      AND (
                          po.status IN ('PLANNED', 'IN_PROGRESS', 'RUNNING', 'HOLD', 'QC_PENDING')
                          OR DATE(po.production_date) = CURDATE()
                          OR DATE(po.created_at) = CURDATE()
                      )
                ), 0) AS planned_today,

                -- Good output produced today: sum from production_entries + completed last processes
                GREATEST(
                    COALESCE((
                        SELECT SUM(pe.good_quantity)
                        FROM production_entries pe
                        WHERE pe.production_date = CURDATE()
                           OR DATE(pe.created_at) = CURDATE()
                    ), 0),
                    COALESCE((
                        SELECT SUM(pop.good_quantity)
                        FROM production_order_processes pop
                        INNER JOIN production_orders po
                            ON po.id = pop.production_order_id
                        WHERE pop.process_status = 'COMPLETED'
                          AND NOT EXISTS (
                              SELECT 1
                              FROM production_order_processes p2
                              WHERE p2.production_order_id = pop.production_order_id
                                AND p2.sequence_no > pop.sequence_no
                          )
                          AND (
                              DATE(pop.end_time) = CURDATE()
                              OR DATE(pop.updated_at) = CURDATE()
                              OR DATE(po.production_date) = CURDATE()
                          )
                    ), 0)
                ) AS good_today,

                -- Rejected output today
                GREATEST(
                    COALESCE((
                        SELECT SUM(pe.rejected_quantity)
                        FROM production_entries pe
                        WHERE pe.production_date = CURDATE()
                           OR DATE(pe.created_at) = CURDATE()
                    ), 0),
                    COALESCE((
                        SELECT SUM(pop.rejected_quantity)
                        FROM production_order_processes pop
                        WHERE DATE(pop.updated_at) = CURDATE()
                           OR DATE(pop.end_time) = CURDATE()
                    ), 0)
                ) AS rejected_today,

                -- Wastage output today
                GREATEST(
                    COALESCE((
                        SELECT SUM(pe.wastage_quantity)
                        FROM production_entries pe
                        WHERE pe.production_date = CURDATE()
                           OR DATE(pe.created_at) = CURDATE()
                    ), 0),
                    COALESCE((
                        SELECT SUM(pop.wastage_quantity)
                        FROM production_order_processes pop
                        WHERE DATE(pop.updated_at) = CURDATE()
                           OR DATE(pop.end_time) = CURDATE()
                    ), 0)
                ) AS wastage_today,

                -- Downtime minutes today
                COALESCE((
                    SELECT SUM(pe.downtime_minutes)
                    FROM production_entries pe
                    WHERE pe.production_date = CURDATE()
                       OR DATE(pe.created_at) = CURDATE()
                ), 0) AS downtime_today
        `);

        const kpi = kpiRows[0] || {};
        const plannedToday = Number(kpi.planned_today || 0);
        const goodToday = Number(kpi.good_today || 0);
        const rejectedToday = Number(kpi.rejected_today || 0);

        const productionEfficiency =
            plannedToday > 0
                ? Number(Math.min(((goodToday / plannedToday) * 100), 100).toFixed(1))
                : (goodToday > 0 ? 100 : 0);

        // 2. Production Stages Aggregation across active orders
        const [stageRows] = await pool.query(`
            SELECT
                p.id AS process_id,
                p.process_code,
                p.process_name,
                p.department,

                COALESCE(SUM(pop.input_quantity), 0) AS input_quantity,
                COALESCE(SUM(pop.good_quantity), 0) AS good_quantity,
                COALESCE(SUM(pop.rejected_quantity), 0) AS rejected_quantity,
                COALESCE(SUM(pop.wastage_quantity), 0) AS wastage_quantity,

                SUM(
                    CASE
                        WHEN pop.process_status = 'RUNNING' THEN 1
                        ELSE 0
                    END
                ) AS running_count,

                SUM(
                    CASE
                        WHEN pop.process_status = 'COMPLETED' THEN 1
                        ELSE 0
                    END
                ) AS completed_count,

                COUNT(pop.id) AS order_process_count

            FROM processes p
            LEFT JOIN product_processes pp
                ON pp.process_id = p.id
            LEFT JOIN production_order_processes pop
                ON pop.product_process_id = pp.id
               AND pop.production_order_id IN (
                   SELECT id FROM production_orders WHERE status NOT IN ('CANCELLED')
               )

            WHERE p.status <> 'INACTIVE'
            GROUP BY
                p.id,
                p.process_code,
                p.process_name,
                p.department
            ORDER BY p.id ASC
        `);

        const stages = stageRows.map((row) => {
            const running = Number(row.running_count || 0);
            const completed = Number(row.completed_count || 0);
            const total = Number(row.order_process_count || 0);

            let status = "IDLE";
            if (running > 0) {
                status = "RUNNING";
            } else if (total > 0 && completed === total) {
                status = "COMPLETED";
            } else if (total > 0) {
                status = "PENDING";
            }

            return {
                ...row,
                input_quantity: Number(row.input_quantity || 0),
                good_quantity: Number(row.good_quantity || 0),
                rejected_quantity: Number(row.rejected_quantity || 0),
                wastage_quantity: Number(row.wastage_quantity || 0),
                running_count: running,
                completed_count: completed,
                order_process_count: total,
                status
            };
        });

        // 3. Active Production Orders List with live progress
        const [orderRows] = await pool.query(`
            SELECT
                po.id,
                po.production_order_number,
                po.product_id,
                p.product_code,
                p.product_name,
                po.planned_quantity,
                po.target_quantity,
                po.production_date,
                po.expected_completion_date,
                po.priority,
                po.shift,
                po.status,

                GREATEST(
                    COALESCE(final_pop.good_quantity, 0),
                    COALESCE((
                        SELECT SUM(pe.good_quantity)
                        FROM production_entries pe
                        WHERE pe.production_order_id = po.id
                    ), 0)
                ) AS produced_quantity,

                COALESCE(final_pop.rejected_quantity, (
                    SELECT SUM(pe.rejected_quantity)
                    FROM production_entries pe
                    WHERE pe.production_order_id = po.id
                ), 0) AS rejected_quantity,

                COALESCE(final_pop.wastage_quantity, (
                    SELECT SUM(pe.wastage_quantity)
                    FROM production_entries pe
                    WHERE pe.production_order_id = po.id
                ), 0) AS wastage_quantity,

                final_pop.start_time,
                final_pop.end_time

            FROM production_orders po
            LEFT JOIN products p
                ON p.id = po.product_id
            LEFT JOIN production_order_processes final_pop
                ON final_pop.id = (
                    SELECT x.id
                    FROM production_order_processes x
                    WHERE x.production_order_id = po.id
                    ORDER BY x.sequence_no DESC
                    LIMIT 1
                )
            WHERE po.status NOT IN ('COMPLETED', 'CANCELLED')
            ORDER BY
                FIELD(po.priority, 'URGENT', 'HIGH', 'NORMAL', 'LOW'),
                po.production_date DESC,
                po.id DESC
            LIMIT 10
        `);

        const orders = orderRows.map((row) => {
            const target = Number(row.target_quantity || row.planned_quantity || 0);
            const produced = Number(row.produced_quantity || 0);
            const progress = target > 0 ? Math.min(Number(((produced / target) * 100).toFixed(1)), 100) : 0;

            return {
                ...row,
                planned_quantity: Number(row.planned_quantity || 0),
                target_quantity: target,
                produced_quantity: produced,
                rejected_quantity: Number(row.rejected_quantity || 0),
                wastage_quantity: Number(row.wastage_quantity || 0),
                progress_percentage: progress
            };
        });

        // 4. Live Alerts
        const [alertRows] = await pool.query(`
            SELECT
                pop.id,
                po.production_order_number,
                p.process_name,
                pop.process_status,
                pop.rejected_quantity,
                pop.input_quantity,
                pop.wastage_quantity,
                pop.start_time
            FROM production_order_processes pop
            INNER JOIN production_orders po
                ON po.id = pop.production_order_id
            INNER JOIN product_processes pp
                ON pp.id = pop.product_process_id
            INNER JOIN processes p
                ON p.id = pp.process_id
            WHERE po.status NOT IN ('COMPLETED', 'CANCELLED')
              AND (
                    pop.process_status = 'HOLD'
                    OR (
                        pop.input_quantity > 0
                        AND (pop.rejected_quantity / pop.input_quantity) >= 0.05
                    )
              )
            ORDER BY pop.updated_at DESC
            LIMIT 6
        `);

        const alerts = alertRows.map((row) => {
            const input = Number(row.input_quantity || 0);
            const rejected = Number(row.rejected_quantity || 0);
            const rejectionRate = input > 0 ? (rejected / input) * 100 : 0;

            if (row.process_status === "HOLD") {
                return {
                    type: "warning",
                    title: "Process on hold",
                    message: `${row.process_name} is on HOLD for ${row.production_order_number}.`,
                    time: row.start_time
                };
            }

            return {
                type: "danger",
                title: "High rejection rate",
                message: `${row.process_name} rejection is ${rejectionRate.toFixed(1)}% on ${row.production_order_number}.`,
                time: row.start_time
            };
        });

        res.json({
            success: true,
            data: {
                date: new Date().toISOString().slice(0, 10),
                kpis: {
                    active_orders: Number(kpi.active_orders || 0),
                    planned_today: plannedToday,
                    good_today: goodToday,
                    rejected_today: rejectedToday,
                    wastage_today: Number(kpi.wastage_today || 0),
                    downtime_today: Number(kpi.downtime_today || 0),
                    production_efficiency: productionEfficiency
                },
                stages,
                orders,
                alerts
            }
        });
    } catch (error) {
        console.error("Dashboard Overview Error:", error);
        res.status(500).json({
            success: false,
            message: "Unable to load production dashboard",
            error: error.message
        });
    }
};

module.exports = {
    getDashboardOverview
};
