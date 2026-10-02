const pool = require("../config/database");

/**
 * Generate sequential Inspection Number: QC-YYYYMMDD-XXXX
 */
const generateInspectionNumber = async (connection) => {
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, "");
    const prefix = `QC-${dateStr}-`;

    const [rows] = await connection.query(
        `SELECT inspection_number FROM carpet_roll_inspections WHERE inspection_number LIKE ? ORDER BY id DESC LIMIT 1`,
        [`${prefix}%`]
    );

    let seq = 1;
    if (rows.length > 0) {
        const lastNumber = rows[0].inspection_number;
        const lastSeq = parseInt(lastNumber.split("-")[2], 10);
        if (!isNaN(lastSeq)) seq = lastSeq + 1;
    }

    return `${prefix}${String(seq).padStart(4, "0")}`;
};

/**
 * Generate Certificate of Analysis Number: COA-YYYYMMDD-XXXX
 */
const generateCOANumber = async (connection) => {
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, "");
    const prefix = `COA-${dateStr}-`;

    const [rows] = await connection.query(
        `SELECT coa_number FROM carpet_roll_inspections WHERE coa_number LIKE ? ORDER BY id DESC LIMIT 1`,
        [`${prefix}%`]
    );

    let seq = 1;
    if (rows.length > 0) {
        const lastNumber = rows[0].coa_number;
        const lastSeq = parseInt(lastNumber.split("-")[2], 10);
        if (!isNaN(lastSeq)) seq = lastSeq + 1;
    }

    return `${prefix}${String(seq).padStart(4, "0")}`;
};

// =========================================================
// 1. GET ALL ROLL INSPECTIONS
// =========================================================
const getInspections = async (req, res) => {
    try {
        const { grade, result, roll_id, search } = req.query;

        let query = `
            SELECT 
                cri.*,
                cr.roll_number,
                cr.width_m,
                cr.length_m,
                cr.area_sqm,
                cr.net_weight_kg,
                cr.warehouse_location,
                p.product_code,
                p.product_name,
                p.carpet_type,
                p.colour,
                p.design_pattern,
                po.production_order_number
            FROM carpet_roll_inspections cri
            INNER JOIN carpet_rolls cr ON cr.id = cri.roll_id
            INNER JOIN products p ON p.id = cri.product_id
            INNER JOIN production_orders po ON po.id = cri.production_order_id
            WHERE 1=1
        `;

        const params = [];

        if (grade) {
            query += ` AND cri.assigned_grade = ?`;
            params.push(grade);
        }

        if (result) {
            query += ` AND cri.overall_result = ?`;
            params.push(result);
        }

        if (roll_id) {
            query += ` AND cri.roll_id = ?`;
            params.push(roll_id);
        }

        if (search) {
            query += ` AND (cr.roll_number LIKE ? OR cri.inspection_number LIKE ? OR cri.coa_number LIKE ? OR p.product_name LIKE ?)`;
            const s = `%${search}%`;
            params.push(s, s, s, s);
        }

        query += ` ORDER BY cri.id DESC`;

        const [rows] = await pool.query(query, params);

        res.json({
            success: true,
            data: rows
        });
    } catch (error) {
        console.error("GET INSPECTIONS ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch roll inspections",
            error: error.message
        });
    }
};

// =========================================================
// 2. GET SINGLE INSPECTION BY ID (WITH FULL COA DATA)
// =========================================================
const getInspectionById = async (req, res) => {
    try {
        const { id } = req.params;

        const [rows] = await pool.query(`
            SELECT 
                cri.*,
                cr.roll_number,
                cr.width_m,
                cr.length_m,
                cr.area_sqm,
                cr.gross_weight_kg,
                cr.core_weight_kg,
                cr.net_weight_kg,
                cr.warehouse_location,
                cr.created_at AS roll_produced_at,
                p.product_code,
                p.product_name,
                p.carpet_type,
                p.colour,
                p.design_pattern,
                po.production_order_number,
                e.name AS official_inspector_name
            FROM carpet_roll_inspections cri
            INNER JOIN carpet_rolls cr ON cr.id = cri.roll_id
            INNER JOIN products p ON p.id = cri.product_id
            INNER JOIN production_orders po ON po.id = cri.production_order_id
            LEFT JOIN employees e ON e.id = cri.inspector_id
            WHERE cri.id = ?
            LIMIT 1
        `, [id]);

        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Inspection test report not found."
            });
        }

        res.json({
            success: true,
            data: rows[0]
        });
    } catch (error) {
        console.error("GET INSPECTION BY ID ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch inspection details",
            error: error.message
        });
    }
};

// =========================================================
// 3. GET ROLL PRE-FILL FOR INSPECTION
// =========================================================
const getRollForInspection = async (req, res) => {
    try {
        const { code } = req.params;
        const cleanCode = (code || "").trim();

        const [rows] = await pool.query(`
            SELECT 
                cr.*,
                p.product_code,
                p.product_name,
                p.carpet_type,
                p.design_pattern,
                p.colour,
                p.thickness_mm AS nominal_thickness_mm,
                p.gsm AS nominal_gsm,
                po.production_order_number
            FROM carpet_rolls cr
            INNER JOIN products p ON p.id = cr.product_id
            INNER JOIN production_orders po ON po.id = cr.production_order_id
            WHERE cr.roll_number = ? OR cr.id = ?
            LIMIT 1
        `, [cleanCode, isNaN(cleanCode) ? 0 : parseInt(cleanCode, 10)]);

        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: `Roll '${cleanCode}' not found.`
            });
        }

        const roll = rows[0];

        // Also check if already inspected
        const [existingInspections] = await pool.query(
            `SELECT id, inspection_number, coa_number, assigned_grade, overall_result, inspection_date 
             FROM carpet_roll_inspections 
             WHERE roll_id = ? 
             ORDER BY id DESC LIMIT 1`,
            [roll.id]
        );

        res.json({
            success: true,
            data: {
                ...roll,
                previous_inspection: existingInspections[0] || null
            }
        });
    } catch (error) {
        console.error("GET ROLL FOR INSPECTION ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to load roll details for inspection",
            error: error.message
        });
    }
};

// =========================================================
// 4. CREATE COMPREHENSIVE LAB INSPECTION & ISSUE COA
// =========================================================
const createInspection = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const {
            roll_id,
            inspector_name = "Quality Control Lead",
            inspector_id,
            // 3-Point Thickness
            target_thickness_mm = 1.500,
            edge_left_thickness_mm,
            center_thickness_mm,
            edge_right_thickness_mm,
            // GSM
            target_gsm = 1600.00,
            actual_gsm,
            // Mechanical
            tensile_md_n = 420.00,
            tensile_cd_n = 380.00,
            elongation_pct = 22.50,
            tear_resistance_n = 65.00,
            heat_shrinkage_pct = 0.40,
            // Visual
            emboss_depth_mm = 0.25,
            color_shade_delta_e = 0.45,
            pinholes_count = 0,
            surface_scratches_count = 0,
            air_bubbles_count = 0,
            visual_defects_notes = "",
            // Grading overrides
            assigned_grade,
            remarks
        } = req.body;

        let targetRollId = roll_id;
        const targetRollNumber = req.body.roll_number;

        let rollRows;
        if (targetRollId) {
            [rollRows] = await connection.query(
                `SELECT cr.id, cr.roll_number, cr.product_id, cr.production_order_id, cr.width_m, cr.length_m, cr.net_weight_kg,
                        p.thickness_mm AS nominal_thickness_mm, p.gsm AS nominal_gsm
                 FROM carpet_rolls cr
                 LEFT JOIN products p ON p.id = cr.product_id
                 WHERE cr.id = ?`,
                [targetRollId]
            );
        } else if (targetRollNumber) {
            [rollRows] = await connection.query(
                `SELECT cr.id, cr.roll_number, cr.product_id, cr.production_order_id, cr.width_m, cr.length_m, cr.net_weight_kg,
                        p.thickness_mm AS nominal_thickness_mm, p.gsm AS nominal_gsm
                 FROM carpet_rolls cr
                 LEFT JOIN products p ON p.id = cr.product_id
                 WHERE cr.roll_number = ?`,
                [targetRollNumber]
            );
        } else {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "Either roll_id or roll_number is required for inspection."
            });
        }

        if (!rollRows || rollRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({
                success: false,
                message: "Target carpet roll not found."
            });
        }

        const roll = rollRows[0];

        // 1. Thickness Calculations (Edge-Center-Edge)
        const targetThick = parseFloat(target_thickness_mm || roll.nominal_thickness_mm || 2.000);
        const left = parseFloat(edge_left_thickness_mm || targetThick);
        const center = parseFloat(center_thickness_mm || targetThick);
        const right = parseFloat(edge_right_thickness_mm || targetThick);

        const avgThickness = parseFloat(((left + center + right) / 3).toFixed(3));
        const variance = parseFloat((Math.max(left, center, right) - Math.min(left, center, right)).toFixed(3));
        
        // Pass if avg is within +/- 0.08mm of target and max variance across width <= 0.12mm
        const thicknessPass = Math.abs(avgThickness - targetThick) <= 0.08 && variance <= 0.12;
        const thickness_result = thicknessPass ? "PASS" : "FAIL";

        // 2. GSM Calculations
        const targetGsmVal = parseFloat(target_gsm || roll.nominal_gsm || 1450.00);
        const actualGsmVal = parseFloat(actual_gsm || targetGsmVal);
        const gsmDeviationPct = parseFloat((((actualGsmVal - targetGsmVal) / targetGsmVal) * 100).toFixed(2));
        
        // Pass if GSM is within +/- 4.5% of nominal
        const gsmPass = Math.abs(gsmDeviationPct) <= 4.5;
        const gsm_result = gsmPass ? "PASS" : "FAIL";

        // 3. Tensile Calculations (Standard PVC threshold: MD >= 350 N/50mm, CD >= 300 N/50mm)
        const tMD = parseFloat(tensile_md_n || 400);
        const tCD = parseFloat(tensile_cd_n || 360);
        const tensilePass = tMD >= 350 && tCD >= 300;
        const tensile_result = tensilePass ? "PASS" : "FAIL";

        // 4. Automated Grade Determination
        const totalVisualDefects = parseInt(pinholes_count || 0, 10) +
            parseInt(surface_scratches_count || 0, 10) +
            parseInt(air_bubbles_count || 0, 10);

        let calculatedGrade = "GRADE_A";
        let overall_result = "PASS";

        if (!thicknessPass || !tensilePass || Math.abs(gsmDeviationPct) > 10.0 || totalVisualDefects > 5) {
            calculatedGrade = "SCRAP";
            overall_result = "FAIL";
        } else if (!gsmPass || totalVisualDefects > 1 || parseFloat(color_shade_delta_e || 0) > 1.2 || variance > 0.08) {
            calculatedGrade = "GRADE_B";
            overall_result = "CONDITIONAL";
        }

        // Final grade can be overridden by authorized QC Inspector
        const finalGrade = assigned_grade || calculatedGrade;
        if (finalGrade === "SCRAP") {
            overall_result = "FAIL";
        }

        // Generate identifiers
        const inspection_number = await generateInspectionNumber(connection);
        const coa_number = await generateCOANumber(connection);

        // Insert inspection record
        const [insertResult] = await connection.query(
            `INSERT INTO carpet_roll_inspections (
                inspection_number, coa_number, roll_id, production_order_id, product_id, 
                inspector_id, inspector_name, inspection_date,
                target_thickness_mm, edge_left_thickness_mm, center_thickness_mm, edge_right_thickness_mm, 
                avg_thickness_mm, thickness_variance_mm, thickness_result,
                target_gsm, actual_gsm, gsm_deviation_pct, gsm_result,
                tensile_md_n, tensile_cd_n, tensile_result, elongation_pct, tear_resistance_n, heat_shrinkage_pct,
                emboss_depth_mm, color_shade_delta_e, pinholes_count, surface_scratches_count, air_bubbles_count, 
                visual_defects_notes, assigned_grade, overall_result, remarks
            ) VALUES (
                ?, ?, ?, ?, ?, 
                ?, ?, NOW(),
                ?, ?, ?, ?, 
                ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, 
                ?, ?, ?, ?
            )`,
            [
                inspection_number,
                coa_number,
                roll.id,
                roll.production_order_id,
                roll.product_id,
                inspector_id || null,
                inspector_name,
                targetThick,
                left,
                center,
                right,
                avgThickness,
                variance,
                thickness_result,
                targetGsmVal,
                actualGsmVal,
                gsmDeviationPct,
                gsm_result,
                tMD,
                tCD,
                tensile_result,
                parseFloat(elongation_pct || 0),
                parseFloat(tear_resistance_n || 0),
                parseFloat(heat_shrinkage_pct || 0),
                parseFloat(emboss_depth_mm || 0),
                parseFloat(color_shade_delta_e || 0.5),
                parseInt(pinholes_count || 0, 10),
                parseInt(surface_scratches_count || 0, 10),
                parseInt(air_bubbles_count || 0, 10),
                visual_defects_notes || null,
                finalGrade,
                overall_result,
                remarks || null
            ]
        );

        // Update target carpet roll with verified measurements and QA status
        const nextRollStatus = finalGrade === "SCRAP" ? "REJECTED" : "APPROVED";
        const defectNote = visual_defects_notes || (!thicknessPass ? "Thickness Variance Out of Spec" : null);

        await connection.query(
            `UPDATE carpet_rolls 
             SET grade = ?, 
                 status = ?, 
                 thickness_mm = ?, 
                 gsm = ?, 
                 defect_type = ?, 
                 updated_at = NOW() 
             WHERE id = ?`,
            [finalGrade, nextRollStatus, avgThickness, actualGsmVal, defectNote, roll.id]
        );

        await connection.commit();

        res.status(201).json({
            success: true,
            message: `Inspection ${inspection_number} completed. Certificate of Analysis ${coa_number} issued.`,
            inspection_id: insertResult.insertId,
            inspection_number,
            coa_number,
            assigned_grade: finalGrade,
            overall_result
        });
    } catch (error) {
        await connection.rollback();
        console.error("CREATE INSPECTION ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to record roll inspection",
            error: error.message
        });
    } finally {
        connection.release();
    }
};

// =========================================================
// 5. GET QC KPI STATS
// =========================================================
const getQCStats = async (req, res) => {
    try {
        const [statsRows] = await pool.query(`
            SELECT 
                COUNT(*) AS total_inspections,
                SUM(CASE WHEN overall_result = 'PASS' THEN 1 ELSE 0 END) AS pass_count,
                SUM(CASE WHEN assigned_grade = 'GRADE_A' THEN 1 ELSE 0 END) AS grade_a_count,
                SUM(CASE WHEN assigned_grade = 'GRADE_B' THEN 1 ELSE 0 END) AS grade_b_count,
                SUM(CASE WHEN assigned_grade = 'GRADE_C' THEN 1 ELSE 0 END) AS grade_c_count,
                SUM(CASE WHEN assigned_grade = 'SCRAP' OR overall_result = 'FAIL' THEN 1 ELSE 0 END) AS scrap_count,
                AVG(thickness_variance_mm) AS avg_thickness_variance_mm,
                AVG(ABS(gsm_deviation_pct)) AS avg_gsm_deviation_pct
            FROM carpet_roll_inspections
        `);

        const [awaitingCount] = await pool.query(`
            SELECT COUNT(*) AS awaiting_qc_count 
            FROM carpet_rolls 
            WHERE status IN ('PRODUCED', 'QC_INSPECTION')
        `);

        const s = statsRows[0] || {};
        const total = parseInt(s.total_inspections || 0, 10);
        const passRate = total > 0 ? ((parseInt(s.pass_count || 0, 10) / total) * 100).toFixed(1) : "100.0";
        const gradeAYield = total > 0 ? ((parseInt(s.grade_a_count || 0, 10) / total) * 100).toFixed(1) : "100.0";

        res.json({
            success: true,
            data: {
                total_inspections: total,
                pass_count: parseInt(s.pass_count || 0, 10),
                pass_rate_pct: Number(passRate),
                grade_a_count: parseInt(s.grade_a_count || 0, 10),
                grade_a_yield_pct: Number(gradeAYield),
                grade_b_count: parseInt(s.grade_b_count || 0, 10),
                grade_c_count: parseInt(s.grade_c_count || 0, 10),
                scrap_count: parseInt(s.scrap_count || 0, 10),
                avg_thickness_variance_mm: parseFloat(s.avg_thickness_variance_mm || 0.04).toFixed(3),
                avg_gsm_deviation_pct: parseFloat(s.avg_gsm_deviation_pct || 1.2).toFixed(2),
                awaiting_qc_count: parseInt(awaitingCount[0]?.awaiting_qc_count || 0, 10)
            }
        });
    } catch (error) {
        console.error("GET QC STATS ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to calculate QC statistics",
            error: error.message
        });
    }
};

module.exports = {
    getInspections,
    getInspectionById,
    getRollForInspection,
    createInspection,
    getQCStats
};
