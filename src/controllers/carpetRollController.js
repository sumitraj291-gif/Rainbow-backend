const pool = require("../config/database");

/**
 * Generate unique roll number
 * Format: ROL-YYYYMMDD-XXXX
 */
const generateRollNumber = async (connection) => {
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, "");
    const prefix = `ROL-${dateStr}-`;

    const [rows] = await connection.query(`
        SELECT roll_number 
        FROM carpet_rolls 
        WHERE roll_number LIKE ? 
        ORDER BY id DESC 
        LIMIT 1
    `, [`${prefix}%`]);

    let seq = 1;
    if (rows.length > 0) {
        const lastNumber = rows[0].roll_number;
        const lastSeq = parseInt(lastNumber.split("-")[2], 10);
        if (!isNaN(lastSeq)) {
            seq = lastSeq + 1;
        }
    }

    return `${prefix}${String(seq).padStart(4, "0")}`;
};

// =========================================================
// GET ALL CARPET ROLLS (WITH FILTERING & PAGINATION/SEARCH)
// =========================================================
const getCarpetRolls = async (req, res) => {
    try {
        const {
            production_order_id,
            product_id,
            grade,
            status,
            search
        } = req.query;

        let query = `
            SELECT 
                cr.id,
                cr.roll_number,
                cr.production_order_id,
                po.production_order_number,
                cr.product_id,
                p.product_code,
                p.product_name,
                p.carpet_type,
                p.design_pattern,
                p.colour,
                cr.process_id,
                proc.process_name,
                cr.machine_id,
                m.machine_name,
                cr.operator_id,
                e.name AS operator_name,
                cr.width_m,
                cr.length_m,
                cr.area_sqm,
                cr.thickness_mm,
                cr.gsm,
                cr.gross_weight_kg,
                cr.core_weight_kg,
                cr.net_weight_kg,
                cr.grade,
                cr.defect_type,
                cr.status,
                cr.warehouse_location,
                cr.barcode,
                cr.notes,
                cr.created_at,
                cr.updated_at
            FROM carpet_rolls cr
            INNER JOIN production_orders po ON po.id = cr.production_order_id
            INNER JOIN products p ON p.id = cr.product_id
            LEFT JOIN processes proc ON proc.id = cr.process_id
            LEFT JOIN machines m ON m.id = cr.machine_id
            LEFT JOIN employees e ON e.id = cr.operator_id
            WHERE 1=1
        `;

        const params = [];

        if (production_order_id) {
            query += ` AND cr.production_order_id = ?`;
            params.push(production_order_id);
        }

        if (product_id) {
            query += ` AND cr.product_id = ?`;
            params.push(product_id);
        }

        if (grade) {
            query += ` AND cr.grade = ?`;
            params.push(grade);
        }

        if (status) {
            query += ` AND cr.status = ?`;
            params.push(status);
        }

        if (search) {
            query += ` AND (
                cr.roll_number LIKE ? 
                OR p.product_name LIKE ? 
                OR p.product_code LIKE ?
                OR po.production_order_number LIKE ?
            )`;
            const s = `%${search}%`;
            params.push(s, s, s, s);
        }

        query += ` ORDER BY cr.id DESC`;

        const [rows] = await pool.query(query, params);

        res.json({
            success: true,
            data: rows
        });
    } catch (error) {
        console.error("Get Carpet Rolls Error:", error);
        res.status(500).json({
            success: false,
            message: "Unable to load carpet rolls",
            error: error.message
        });
    }
};

// =========================================================
// GET ROLL BY ID
// =========================================================
const getCarpetRollById = async (req, res) => {
    try {
        const { id } = req.params;

        const [rows] = await pool.query(`
            SELECT 
                cr.*,
                po.production_order_number,
                p.product_code,
                p.product_name,
                p.carpet_type,
                p.design_pattern,
                p.colour,
                proc.process_name,
                m.machine_name,
                e.name AS operator_name
            FROM carpet_rolls cr
            INNER JOIN production_orders po ON po.id = cr.production_order_id
            INNER JOIN products p ON p.id = cr.product_id
            LEFT JOIN processes proc ON proc.id = cr.process_id
            LEFT JOIN machines m ON m.id = cr.machine_id
            LEFT JOIN employees e ON e.id = cr.operator_id
            WHERE cr.id = ?
            LIMIT 1
        `, [id]);

        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Carpet roll not found"
            });
        }

        res.json({
            success: true,
            data: rows[0]
        });
    } catch (error) {
        console.error("Get Carpet Roll Details Error:", error);
        res.status(500).json({
            success: false,
            message: "Unable to load carpet roll details",
            error: error.message
        });
    }
};

// =========================================================
// CREATE SINGLE ROLL
// =========================================================
const createCarpetRoll = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        const {
            production_order_id,
            product_id,
            process_id,
            machine_id,
            operator_id,
            roll_number,
            width_m,
            length_m,
            thickness_mm,
            gsm,
            gross_weight_kg,
            core_weight_kg,
            grade,
            defect_type,
            status,
            warehouse_location,
            notes
        } = req.body;

        if (!production_order_id) {
            return res.status(400).json({
                success: false,
                message: "Production Order is required"
            });
        }

        const width = Number(width_m || 2.0);
        const length = Number(length_m || 0);

        if (length <= 0) {
            return res.status(400).json({
                success: false,
                message: "Roll length must be greater than zero meters"
            });
        }

        const area_sqm = Number((width * length).toFixed(2));
        const coreWeight = Number(core_weight_kg || 0);
        const grossWeight = gross_weight_kg ? Number(gross_weight_kg) : null;
        let netWeight = null;
        if (grossWeight !== null) {
            netWeight = Number(Math.max(0, grossWeight - coreWeight).toFixed(2));
        }

        // Determine product_id from order if not supplied
        let resolvedProductId = product_id;
        if (!resolvedProductId) {
            const [orders] = await connection.query(
                "SELECT product_id FROM production_orders WHERE id = ? LIMIT 1",
                [production_order_id]
            );
            if (orders.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: "Associated production order not found"
                });
            }
            resolvedProductId = orders[0].product_id;
        }

        await connection.beginTransaction();

        const rollNum = roll_number?.trim() || await generateRollNumber(connection);
        const barcodeValue = rollNum;

        const [result] = await connection.query(`
            INSERT INTO carpet_rolls (
                roll_number,
                production_order_id,
                product_id,
                process_id,
                machine_id,
                operator_id,
                width_m,
                length_m,
                area_sqm,
                thickness_mm,
                gsm,
                gross_weight_kg,
                core_weight_kg,
                net_weight_kg,
                grade,
                defect_type,
                status,
                warehouse_location,
                barcode,
                notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            rollNum,
            production_order_id,
            resolvedProductId,
            process_id || null,
            machine_id || null,
            operator_id || null,
            width,
            length,
            area_sqm,
            thickness_mm || null,
            gsm || null,
            grossWeight,
            coreWeight,
            netWeight,
            grade || "GRADE_A",
            defect_type || null,
            status || "PRODUCED",
            warehouse_location || null,
            barcodeValue,
            notes || null
        ]);

        await connection.commit();

        res.status(201).json({
            success: true,
            message: `Carpet roll ${rollNum} created successfully`,
            data: {
                id: result.insertId,
                roll_number: rollNum,
                area_sqm,
                net_weight_kg: netWeight
            }
        });
    } catch (error) {
        await connection.rollback();
        console.error("Create Carpet Roll Error:", error);
        res.status(500).json({
            success: false,
            message: "Unable to create carpet roll",
            error: error.message
        });
    } finally {
        connection.release();
    }
};

// =========================================================
// BULK CREATE ROLLS (E.G. GENERATE N ROLLS FROM ONE RUN)
// =========================================================
const bulkCreateCarpetRolls = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        const {
            production_order_id,
            product_id,
            process_id,
            machine_id,
            operator_id,
            roll_count,
            length_m,
            width_m,
            thickness_mm,
            gsm,
            gross_weight_kg,
            core_weight_kg,
            grade,
            warehouse_location,
            notes
        } = req.body;

        const count = parseInt(roll_count, 10);
        if (isNaN(count) || count < 1 || count > 50) {
            return res.status(400).json({
                success: false,
                message: "Roll count must be between 1 and 50"
            });
        }

        const width = Number(width_m || 2.0);
        const length = Number(length_m || 0);
        if (length <= 0) {
            return res.status(400).json({
                success: false,
                message: "Length per roll must be greater than zero meters"
            });
        }

        const area_sqm = Number((width * length).toFixed(2));
        const coreWeight = Number(core_weight_kg || 0);
        const grossWeight = gross_weight_kg ? Number(gross_weight_kg) : null;
        let netWeight = null;
        if (grossWeight !== null) {
            netWeight = Number(Math.max(0, grossWeight - coreWeight).toFixed(2));
        }

        let resolvedProductId = product_id;
        if (!resolvedProductId) {
            const [orders] = await connection.query(
                "SELECT product_id FROM production_orders WHERE id = ? LIMIT 1",
                [production_order_id]
            );
            if (orders.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: "Associated production order not found"
                });
            }
            resolvedProductId = orders[0].product_id;
        }

        await connection.beginTransaction();

        const createdRolls = [];

        for (let i = 0; i < count; i++) {
            const rollNum = await generateRollNumber(connection);
            const barcodeValue = rollNum;

            const [result] = await connection.query(`
                INSERT INTO carpet_rolls (
                    roll_number,
                    production_order_id,
                    product_id,
                    process_id,
                    machine_id,
                    operator_id,
                    width_m,
                    length_m,
                    area_sqm,
                    thickness_mm,
                    gsm,
                    gross_weight_kg,
                    core_weight_kg,
                    net_weight_kg,
                    grade,
                    status,
                    warehouse_location,
                    barcode,
                    notes
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                rollNum,
                production_order_id,
                resolvedProductId,
                process_id || null,
                machine_id || null,
                operator_id || null,
                width,
                length,
                area_sqm,
                thickness_mm || null,
                gsm || null,
                grossWeight,
                coreWeight,
                netWeight,
                grade || "GRADE_A",
                "PRODUCED",
                warehouse_location || null,
                barcodeValue,
                notes || null
            ]);

            createdRolls.push({
                id: result.insertId,
                roll_number: rollNum
            });
        }

        await connection.commit();

        res.status(201).json({
            success: true,
            message: `Successfully generated ${count} carpet rolls`,
            data: createdRolls
        });
    } catch (error) {
        await connection.rollback();
        console.error("Bulk Create Carpet Rolls Error:", error);
        res.status(500).json({
            success: false,
            message: "Unable to bulk generate carpet rolls",
            error: error.message
        });
    } finally {
        connection.release();
    }
};

// =========================================================
// UPDATE ROLL (GRADE, STATUS, WEIGHT, DEFECTS, NOTES)
// =========================================================
const updateCarpetRoll = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            width_m,
            length_m,
            thickness_mm,
            gsm,
            gross_weight_kg,
            core_weight_kg,
            grade,
            defect_type,
            status,
            warehouse_location,
            notes
        } = req.body;

        const [existing] = await pool.query("SELECT * FROM carpet_rolls WHERE id = ? LIMIT 1", [id]);
        if (existing.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Carpet roll not found"
            });
        }

        const current = existing[0];
        const width = width_m !== undefined ? Number(width_m) : Number(current.width_m);
        const length = length_m !== undefined ? Number(length_m) : Number(current.length_m);
        const area_sqm = Number((width * length).toFixed(2));

        const coreWeight = core_weight_kg !== undefined ? Number(core_weight_kg) : Number(current.core_weight_kg || 0);
        const grossWeight = gross_weight_kg !== undefined ? (gross_weight_kg !== null ? Number(gross_weight_kg) : null) : current.gross_weight_kg;
        let netWeight = null;
        if (grossWeight !== null && grossWeight !== undefined) {
            netWeight = Number(Math.max(0, grossWeight - coreWeight).toFixed(2));
        }

        await pool.query(`
            UPDATE carpet_rolls
            SET
                width_m = ?,
                length_m = ?,
                area_sqm = ?,
                thickness_mm = ?,
                gsm = ?,
                gross_weight_kg = ?,
                core_weight_kg = ?,
                net_weight_kg = ?,
                grade = ?,
                defect_type = ?,
                status = ?,
                warehouse_location = ?,
                notes = ?
            WHERE id = ?
        `, [
            width,
            length,
            area_sqm,
            thickness_mm !== undefined ? thickness_mm : current.thickness_mm,
            gsm !== undefined ? gsm : current.gsm,
            grossWeight,
            coreWeight,
            netWeight,
            grade || current.grade,
            defect_type !== undefined ? defect_type : current.defect_type,
            status || current.status,
            warehouse_location !== undefined ? warehouse_location : current.warehouse_location,
            notes !== undefined ? notes : current.notes,
            id
        ]);

        res.json({
            success: true,
            message: "Carpet roll updated successfully"
        });
    } catch (error) {
        console.error("Update Carpet Roll Error:", error);
        res.status(500).json({
            success: false,
            message: "Unable to update carpet roll",
            error: error.message
        });
    }
};

// =========================================================
// DELETE ROLL
// =========================================================
const deleteCarpetRoll = async (req, res) => {
    try {
        const { id } = req.params;

        const [existing] = await pool.query("SELECT status FROM carpet_rolls WHERE id = ? LIMIT 1", [id]);
        if (existing.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Carpet roll not found"
            });
        }

        if (existing[0].status === "DISPATCHED") {
            return res.status(400).json({
                success: false,
                message: "Dispatched rolls cannot be deleted"
            });
        }

        await pool.query("DELETE FROM carpet_rolls WHERE id = ?", [id]);

        res.json({
            success: true,
            message: "Carpet roll deleted successfully"
        });
    } catch (error) {
        console.error("Delete Carpet Roll Error:", error);
        res.status(500).json({
            success: false,
            message: "Unable to delete carpet roll",
            error: error.message
        });
    }
};

// =========================================================
// AGGREGATE SUMMARY & STATS
// =========================================================
const getCarpetRollStats = async (req, res) => {
    try {
        const { production_order_id } = req.query;
        let whereClause = "";
        const params = [];

        if (production_order_id) {
            whereClause = "WHERE production_order_id = ?";
            params.push(production_order_id);
        }

        const [summaryRows] = await pool.query(`
            SELECT 
                COUNT(*) AS total_rolls,
                COALESCE(SUM(length_m), 0) AS total_length_m,
                COALESCE(SUM(area_sqm), 0) AS total_area_sqm,
                COALESCE(SUM(net_weight_kg), 0) AS total_net_weight_kg,
                COALESCE(SUM(CASE WHEN grade = 'GRADE_A' THEN 1 ELSE 0 END), 0) AS grade_a_count,
                COALESCE(SUM(CASE WHEN grade = 'GRADE_B' THEN 1 ELSE 0 END), 0) AS grade_b_count,
                COALESCE(SUM(CASE WHEN grade = 'GRADE_C' THEN 1 ELSE 0 END), 0) AS grade_c_count,
                COALESCE(SUM(CASE WHEN grade = 'SCRAP' THEN 1 ELSE 0 END), 0) AS scrap_count
            FROM carpet_rolls
            ${whereClause}
        `, params);

        const summary = summaryRows[0] || {};
        const total = summary.total_rolls || 0;
        const gradeAYield = total > 0 ? ((summary.grade_a_count / total) * 100).toFixed(1) : "0.0";

        res.json({
            success: true,
            data: {
                ...summary,
                grade_a_yield_pct: Number(gradeAYield)
            }
        });
    } catch (error) {
        console.error("Get Carpet Roll Stats Error:", error);
        res.status(500).json({
            success: false,
            message: "Unable to calculate roll statistics",
            error: error.message
        });
    }
};

// =========================================================
// SCAN ROLL BY BARCODE OR ROLL NUMBER
// =========================================================
const scanRoll = async (req, res) => {
    try {
        const { code } = req.params;
        const cleanCode = (code || "").trim();

        if (!cleanCode) {
            return res.status(400).json({
                success: false,
                message: "Barcode or roll number is required."
            });
        }

        const [rows] = await pool.query(`
            SELECT 
                cr.*,
                po.production_order_number,
                p.product_code,
                p.product_name,
                p.carpet_type,
                p.design_pattern,
                p.colour,
                proc.process_name,
                m.machine_name,
                e.name AS operator_name,
                c.company_name AS customer_name,
                d.dispatch_number,
                d.dispatch_date,
                d.vehicle_number
            FROM carpet_rolls cr
            INNER JOIN production_orders po ON po.id = cr.production_order_id
            INNER JOIN products p ON p.id = cr.product_id
            LEFT JOIN processes proc ON proc.id = cr.process_id
            LEFT JOIN machines m ON m.id = cr.machine_id
            LEFT JOIN employees e ON e.id = cr.operator_id
            LEFT JOIN customers c ON c.id = cr.customer_id
            LEFT JOIN dispatches d ON d.id = cr.dispatch_id
            WHERE cr.roll_number = ? OR cr.barcode = ? OR cr.id = ?
            LIMIT 1
        `, [cleanCode, cleanCode, isNaN(cleanCode) ? 0 : parseInt(cleanCode, 10)]);

        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: `No PVC carpet roll found matching code '${cleanCode}'.`
            });
        }

        res.json({
            success: true,
            data: rows[0]
        });
    } catch (error) {
        console.error("Scan Roll Error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to scan roll",
            error: error.message
        });
    }
};

// =========================================================
// QUICK UPDATE ROLL STATUS & LOCATION
// =========================================================
const quickUpdateRoll = async (req, res) => {
    try {
        const { id } = req.params;
        const { status, warehouse_location, grade, notes } = req.body;

        const updates = [];
        const params = [];

        if (status) {
            updates.push("status = ?");
            params.push(status);
            if (status === "IN_WAREHOUSE") {
                updates.push("stocked_at = COALESCE(stocked_at, NOW())");
                updates.push("warehouse_id = 3");
            }
        }

        if (warehouse_location) {
            updates.push("warehouse_location = ?");
            params.push(warehouse_location);
        }

        if (grade) {
            updates.push("grade = ?");
            params.push(grade);
        }

        if (notes !== undefined) {
            updates.push("notes = ?");
            params.push(notes);
        }

        if (updates.length === 0) {
            return res.status(400).json({
                success: false,
                message: "No fields provided to update."
            });
        }

        params.push(id);

        await pool.query(
            `UPDATE carpet_rolls SET ${updates.join(", ")}, updated_at = NOW() WHERE id = ?`,
            params
        );

        const [updatedRows] = await pool.query(
            `SELECT cr.*, p.product_name, po.production_order_number 
             FROM carpet_rolls cr 
             INNER JOIN products p ON p.id = cr.product_id
             INNER JOIN production_orders po ON po.id = cr.production_order_id
             WHERE cr.id = ?`,
            [id]
        );

        res.json({
            success: true,
            message: "Roll updated successfully",
            data: updatedRows[0]
        });
    } catch (error) {
        console.error("Quick Update Roll Error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to update roll",
            error: error.message
        });
    }
};

module.exports = {
    getCarpetRolls,
    getCarpetRollById,
    createCarpetRoll,
    bulkCreateCarpetRolls,
    updateCarpetRoll,
    deleteCarpetRoll,
    getCarpetRollStats,
    scanRoll,
    quickUpdateRoll
};
