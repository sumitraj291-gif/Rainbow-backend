const pool = require("../config/database");

// =========================================================
// HELPER: GENERATE PASTE BATCH NUMBER
// =========================================================
async function generateBatchNumber(connection) {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const prefix = `PST-${today}-`;
    const [rows] = await connection.query(
        `SELECT batch_number FROM paste_mixing_batches WHERE batch_number LIKE ? ORDER BY id DESC LIMIT 1`,
        [`${prefix}%`]
    );

    let nextSeq = 1;
    if (rows.length > 0) {
        const lastNum = rows[0].batch_number;
        const parts = lastNum.split("-");
        const lastSeq = parseInt(parts[parts.length - 1], 10);
        if (!isNaN(lastSeq)) nextSeq = lastSeq + 1;
    }
    return `${prefix}${String(nextSeq).padStart(4, "0")}`;
}

// =========================================================
// 1. GET ALL RAW MATERIALS & STOCK STATUS
// =========================================================
const getRawMaterials = async (req, res) => {
    try {
        const { category_id, search, low_stock } = req.query;

        let query = `
            SELECT 
                rm.*,
                mc.name AS category_name,
                u.name AS unit_name,
                u.symbol AS unit_symbol,
                COALESCE(SUM(mb.current_quantity), 0) AS current_stock_qty,
                (COALESCE(SUM(mb.current_quantity), 0) * rm.standard_purchase_rate) AS total_valuation_inr
            FROM raw_materials rm
            LEFT JOIN material_categories mc ON mc.id = rm.category_id
            LEFT JOIN units u ON u.id = rm.unit_id
            LEFT JOIN material_batches mb ON mb.material_id = rm.id AND mb.qc_status = 'APPROVED'
            WHERE rm.status = 'ACTIVE'
        `;
        const params = [];

        if (category_id) {
            query += ` AND rm.category_id = ?`;
            params.push(category_id);
        }

        if (search) {
            query += ` AND (rm.material_code LIKE ? OR rm.material_name LIKE ? OR rm.grade LIKE ?)`;
            const s = `%${search.trim()}%`;
            params.push(s, s, s);
        }

        query += ` GROUP BY rm.id`;

        if (low_stock === "true") {
            query += ` HAVING current_stock_qty <= rm.reorder_level`;
        }

        query += ` ORDER BY rm.category_id ASC, rm.material_name ASC`;

        const [rows] = await pool.query(query, params);

        res.json({
            success: true,
            data: rows
        });
    } catch (error) {
        console.error("GET RAW MATERIALS ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch raw materials",
            error: error.message
        });
    }
};

// =========================================================
// 2. GET INVENTORY & FORMULATION STATS
// =========================================================
const getInventoryStats = async (req, res) => {
    try {
        const today = new Date().toISOString().slice(0, 10);

        // Valuation & items count - properly aggregate approved batches per material
        const [valRows] = await pool.query(`
            SELECT 
                COUNT(DISTINCT rm.id) AS total_materials,
                COALESCE(SUM(stock.current_stock * rm.standard_purchase_rate), 0) AS total_valuation_inr,
                COUNT(DISTINCT CASE WHEN COALESCE(stock.current_stock, 0) <= rm.reorder_level THEN rm.id END) AS low_stock_items
            FROM raw_materials rm
            LEFT JOIN (
                SELECT material_id, SUM(current_quantity) AS current_stock
                FROM material_batches
                WHERE qc_status = 'APPROVED'
                GROUP BY material_id
            ) stock ON stock.material_id = rm.id
            WHERE rm.status = 'ACTIVE'
        `);

        // Today's Paste Mixing Output
        const [mixingRows] = await pool.query(`
            SELECT 
                COUNT(*) AS today_batches,
                COALESCE(SUM(actual_weight_kg), 0) AS today_paste_kg
            FROM paste_mixing_batches
            WHERE batch_date = ?
        `, [today]);

        // Formulations count
        const [formRows] = await pool.query(`
            SELECT COUNT(*) AS active_formulations FROM chemical_formulations WHERE status = 'ACTIVE'
        `);

        res.json({
            success: true,
            data: {
                total_materials: valRows[0]?.total_materials || 0,
                total_valuation_inr: Number(valRows[0]?.total_valuation_inr || 0).toFixed(2),
                low_stock_items: valRows[0]?.low_stock_items || 0,
                today_batches: mixingRows[0]?.today_batches || 0,
                today_paste_kg: Number(mixingRows[0]?.today_paste_kg || 0).toFixed(2),
                active_formulations: formRows[0]?.active_formulations || 0
            }
        });
    } catch (error) {
        console.error("GET INVENTORY STATS ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to load inventory stats",
            error: error.message
        });
    }
};

// =========================================================
// 3. GET CHEMICAL FORMULATIONS & INGREDIENT RECIPES
// =========================================================
const getFormulations = async (req, res) => {
    try {
        const [formulations] = await pool.query(`
            SELECT * FROM chemical_formulations WHERE status = 'ACTIVE' ORDER BY id ASC
        `);

        // Attach ingredients
        const result = [];
        for (const f of formulations) {
            const [items] = await pool.query(`
                SELECT 
                    cfi.*,
                    rm.material_code,
                    rm.material_name,
                    rm.grade,
                    rm.standard_purchase_rate,
                    u.symbol AS unit_symbol,
                    COALESCE(stock.current_stock, 0) AS available_stock_kg
                FROM chemical_formulation_items cfi
                INNER JOIN raw_materials rm ON rm.id = cfi.material_id
                LEFT JOIN units u ON u.id = rm.unit_id
                LEFT JOIN (
                    SELECT material_id, SUM(current_quantity) AS current_stock 
                    FROM material_batches 
                    WHERE qc_status = 'APPROVED' 
                    GROUP BY material_id
                ) stock ON stock.material_id = rm.id
                WHERE cfi.formulation_id = ?
                ORDER BY cfi.addition_order ASC
            `, [f.id]);

            result.push({
                ...f,
                ingredients: items
            });
        }

        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        console.error("GET FORMULATIONS ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch formulations",
            error: error.message
        });
    }
};

// =========================================================
// 4. GET PASTE MIXING BATCHES
// =========================================================
const getMixingBatches = async (req, res) => {
    try {
        const [batches] = await pool.query(`
            SELECT 
                pmb.*,
                cf.formulation_code,
                cf.formulation_name,
                cf.formulation_type,
                cf.target_viscosity_cp,
                cf.viscosity_tolerance_cp
            FROM paste_mixing_batches pmb
            INNER JOIN chemical_formulations cf ON cf.id = pmb.formulation_id
            ORDER BY pmb.id DESC
        `);

        res.json({
            success: true,
            data: batches
        });
    } catch (error) {
        console.error("GET MIXING BATCHES ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch paste mixing batches",
            error: error.message
        });
    }
};

// =========================================================
// 5. CREATE NEW PASTE MIXING BATCH & DEDUCT RAW MATERIALS
// =========================================================
const createMixingBatch = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const {
            formulation_id,
            mixer_machine_name = "High-Speed Dissolver Mixer #1",
            operator_name,
            batch_date = new Date().toISOString().slice(0, 10),
            start_time = "08:00:00",
            end_time = "09:15:00",
            target_weight_kg = 500.00,
            actual_weight_kg = 500.00,
            measured_viscosity_cp,
            measured_temp_c = 28.5,
            measured_density_g_cm3 = 1.280,
            deaeration_vacuum_bar = -0.85,
            fineness_hegman_microns = 25,
            destination_coating_line = "PVC Coating Line 01",
            remarks
        } = req.body;

        if (!formulation_id) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "Please select a target chemical formulation."
            });
        }

        if (!operator_name) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "Operator / Mixing Master name is required."
            });
        }

        // Fetch formulation
        const [formRows] = await connection.query(
            `SELECT * FROM chemical_formulations WHERE id = ?`,
            [formulation_id]
        );

        if (formRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({
                success: false,
                message: "Formulation not found."
            });
        }

        const formulation = formRows[0];

        // Evaluate Viscosity QC
        const visc = parseInt(measured_viscosity_cp, 10) || formulation.target_viscosity_cp;
        const targetVisc = formulation.target_viscosity_cp;
        const tol = formulation.viscosity_tolerance_cp;
        let qcResult = "PASS";
        let batchStatus = "APPROVED";

        if (Math.abs(visc - targetVisc) <= tol) {
            qcResult = "PASS";
            batchStatus = "APPROVED";
        } else if (Math.abs(visc - targetVisc) <= (tol * 1.5)) {
            qcResult = "BORDERLINE";
            batchStatus = "APPROVED";
        } else {
            qcResult = "FAIL";
            batchStatus = "QC_CHECK";
        }

        const batch_number = await generateBatchNumber(connection);

        // Insert Batch
        const [batchInsert] = await connection.query(`
            INSERT INTO paste_mixing_batches (
                batch_number, formulation_id, mixer_machine_name, operator_name,
                batch_date, start_time, end_time, target_weight_kg, actual_weight_kg,
                measured_viscosity_cp, measured_temp_c, measured_density_g_cm3,
                deaeration_vacuum_bar, fineness_hegman_microns, qc_viscosity_result,
                status, destination_coating_line, remarks
            ) VALUES (
                ?, ?, ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?
            )
        `, [
            batch_number, formulation_id, mixer_machine_name, operator_name,
            batch_date, start_time, end_time, target_weight_kg, actual_weight_kg,
            visc, measured_temp_c, measured_density_g_cm3,
            deaeration_vacuum_bar, fineness_hegman_microns, qcResult,
            batchStatus, destination_coating_line, remarks || ""
        ]);

        const batchId = batchInsert.insertId;

        // Deduct raw material stock proportionally based on formulation recipe
        const [ingredients] = await connection.query(
            `SELECT material_id, qty_kg_per_standard_batch FROM chemical_formulation_items WHERE formulation_id = ?`,
            [formulation_id]
        );

        const batchRatio = parseFloat(actual_weight_kg) / parseFloat(formulation.standard_batch_size_kg || 500);

        for (const ing of ingredients) {
            const requiredQty = parseFloat(ing.qty_kg_per_standard_batch) * batchRatio;
            
            // Deduct from available approved batch (FIFO)
            await connection.query(`
                UPDATE material_batches 
                SET current_quantity = GREATEST(0, current_quantity - ?)
                WHERE material_id = ? AND qc_status = 'APPROVED' AND current_quantity > 0
                ORDER BY id ASC LIMIT 1
            `, [requiredQty, ing.material_id]);
        }

        await connection.commit();

        res.status(201).json({
            success: true,
            message: `Plastisol Batch ${batch_number} mixed & verified! Raw materials deducted from inventory.`,
            data: {
                id: batchId,
                batch_number,
                qc_result: qcResult,
                status: batchStatus
            }
        });
    } catch (error) {
        await connection.rollback();
        console.error("CREATE MIXING BATCH ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to record paste mixing batch",
            error: error.message
        });
    } finally {
        connection.release();
    }
};

// =========================================================
// 6. ISSUE PASTE BATCH TO COATING LINE
// =========================================================
const issueBatchToLine = async (req, res) => {
    try {
        const { id } = req.params;
        const { destination_line = "PVC Coating Line 01" } = req.body;

        await pool.query(`
            UPDATE paste_mixing_batches 
            SET status = 'ISSUED_TO_LINE', destination_coating_line = ?
            WHERE id = ?
        `, [destination_line, id]);

        res.json({
            success: true,
            message: `Paste batch successfully issued to ${destination_line}.`
        });
    } catch (error) {
        console.error("ISSUE BATCH ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to issue batch to line",
            error: error.message
        });
    }
};

// =========================================================
// 7. SEED RAW MATERIAL BATCHES & SAMPLE MIXING RUNS
// =========================================================
const seedRawMaterials = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // Check if batches already exist
        const [existing] = await connection.query(`SELECT COUNT(*) AS count FROM material_batches`);
        if (existing[0].count > 0 && req.query.force !== 'true') {
            await connection.rollback();
            return res.json({
                success: true,
                message: `Inventory batches already initialized (${existing[0].count} batches present).`
            });
        }

        // If force=true, clear existing batches
        if (req.query.force === 'true') {
            await connection.query(`DELETE FROM material_batches`);
            await connection.query(`DELETE FROM paste_mixing_batches`);
        }

        const batches = [
            { material_id: 1, supplier_id: 1, batch_number: 'BAT-PVC-68-01', supplier_batch_number: 'REL-E68-9841', qty: 15000, rate: 115.00 },
            { material_id: 2, supplier_id: 1, batch_number: 'BAT-PVC-65-01', supplier_batch_number: 'REL-S65-4412', qty: 18000, rate: 95.00 },
            { material_id: 3, supplier_id: 2, batch_number: 'BAT-DINP-01', supplier_batch_number: 'BASF-DINP-772', qty: 12000, rate: 142.00 },
            { material_id: 4, supplier_id: 3, batch_number: 'BAT-DOTP-01', supplier_batch_number: 'KLJ-DOTP-551', qty: 8500, rate: 148.00 },
            { material_id: 5, supplier_id: 3, batch_number: 'BAT-ESBO-01', supplier_batch_number: 'KLJ-ESBO-119', qty: 3200, rate: 175.00 },
            { material_id: 6, supplier_id: 4, batch_number: 'BAT-CACO3-01', supplier_batch_number: '20M-PCC-3321', qty: 28000, rate: 18.50 },
            { material_id: 7, supplier_id: 4, batch_number: 'BAT-ATH-01', supplier_batch_number: '20M-ATH-991', qty: 5400, rate: 48.00 },
            { material_id: 8, supplier_id: 5, batch_number: 'BAT-ADC-01', supplier_batch_number: 'BAER-ADC-042', qty: 1800, rate: 320.00 },
            { material_id: 9, supplier_id: 5, batch_number: 'BAT-ZNCA-01', supplier_batch_number: 'BAER-STAB-88', qty: 2400, rate: 260.00 },
            { material_id: 10, supplier_id: 6, batch_number: 'BAT-SUB-01', supplier_batch_number: 'SB-FELT-2026', qty: 9200, rate: 42.00 },
            { material_id: 11, supplier_id: 5, batch_number: 'BAT-PIG-RED-01', supplier_batch_number: 'BAER-PIG-R10', qty: 650, rate: 450.00 },
            { material_id: 12, supplier_id: 5, batch_number: 'BAT-PIG-GRY-01', supplier_batch_number: 'BAER-PIG-G55', qty: 850, rate: 380.00 },
            { material_id: 13, supplier_id: 5, batch_number: 'BAT-PIG-BLU-01', supplier_batch_number: 'BAER-PIG-B12', qty: 220, rate: 420.00 },
            { material_id: 14, supplier_id: 2, batch_number: 'BAT-PU-TOP-01', supplier_batch_number: 'BASF-PU-900', qty: 1600, rate: 520.00 },
        ];

        const today = new Date().toISOString().slice(0, 10);
        const mfgDate = new Date(Date.now() - 15 * 86400000).toISOString().slice(0, 10);
        const expDate = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);

        for (const b of batches) {
            await connection.query(`
                INSERT INTO material_batches (
                    material_id, supplier_id, batch_number, supplier_batch_number,
                    received_date, manufacturing_date, expiry_date,
                    quantity_received, current_quantity, purchase_rate, qc_status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'APPROVED')
            `, [
                b.material_id, b.supplier_id, b.batch_number, b.supplier_batch_number,
                today, mfgDate, expDate, b.qty, b.qty, b.rate
            ]);
        }

        // Also seed 2 realistic paste mixing batches for today if none exist
        const [mixCount] = await connection.query(`SELECT COUNT(*) AS count FROM paste_mixing_batches`);
        if (mixCount[0].count === 0) {
            const todayStr = today.replace(/-/g, "");
            await connection.query(`
                INSERT INTO paste_mixing_batches (
                    batch_number, formulation_id, mixer_machine_name, operator_name,
                    batch_date, start_time, end_time, target_weight_kg, actual_weight_kg,
                    measured_viscosity_cp, measured_temp_c, measured_density_g_cm3,
                    deaeration_vacuum_bar, fineness_hegman_microns, qc_viscosity_result,
                    status, destination_coating_line, remarks
                ) VALUES 
                (
                    ?, 1, 'High-Speed Dissolver Mixer #1', 'Devendra Solanki (Mixing Master)',
                    ?, '08:30:00', '09:45:00', 500.00, 500.00,
                    3850, 28.5, 1.280,
                    -0.85, 25, 'PASS',
                    'ISSUED_TO_LINE', 'PVC Coating Line 01', 'High clarity clear wear plastisol. Vacuum deaerated, zero air pockets.'
                ),
                (
                    ?, 2, 'High-Speed Dissolver Mixer #2', 'Devendra Solanki (Mixing Master)',
                    ?, '10:15:00', '11:30:00', 500.00, 500.00,
                    4200, 29.0, 1.150,
                    -0.82, 30, 'PASS',
                    'APPROVED', 'PVC Coating Line 01', 'Cushion foam layer formulation with ADC blowing agent. Viscosity on spec.'
                )
            `, [
                `PST-${todayStr}-0001`, today,
                `PST-${todayStr}-0002`, today
            ]);
        }

        await connection.commit();

        res.status(201).json({
            success: true,
            message: `Successfully seeded 14 raw material approved batches and 2 paste mixing runs.`
        });
    } catch (error) {
        await connection.rollback();
        console.error("SEED RAW MATERIALS ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to seed raw materials",
            error: error.message
        });
    } finally {
        connection.release();
    }
};

// =========================================================
// 8. GET METADATA (CATEGORIES & UNITS)
// =========================================================
const getMetadata = async (req, res) => {
    try {
        const [categories] = await pool.query(
            "SELECT id, name, description FROM material_categories ORDER BY name ASC"
        );
        const [units] = await pool.query(
            "SELECT id, name, symbol FROM units ORDER BY name ASC"
        );
        res.json({
            success: true,
            data: { categories, units }
        });
    } catch (error) {
        console.error("GET INVENTORY METADATA ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch metadata",
            error: error.message
        });
    }
};

// =========================================================
// 9. CREATE NEW RAW MATERIAL / INVENTORY ITEM
// =========================================================
const createRawMaterial = async (req, res) => {
    const connection = await pool.getConnection();
    await connection.beginTransaction();
    try {
        let {
            material_code,
            material_name,
            category_id,
            unit_id,
            grade,
            minimum_stock,
            reorder_level,
            standard_purchase_rate,
            initial_stock_qty,
            batch_number,
            location_rack
        } = req.body;

        if (!material_name || !material_name.trim()) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "Material name is required"
            });
        }

        // Auto-generate code if not provided
        if (!material_code || !material_code.trim()) {
            const rand = Math.floor(1000 + Math.random() * 9000);
            material_code = `RM-${Date.now().toString().slice(-4)}-${rand}`;
        } else {
            material_code = material_code.trim().toUpperCase();
        }

        // Default unit if not supplied (default to KG id 2 or first unit)
        if (!unit_id) {
            const [u] = await connection.query("SELECT id FROM units WHERE symbol = 'KG' LIMIT 1");
            unit_id = u.length > 0 ? u[0].id : 2;
        }

        const [insertRes] = await connection.query(
            `
            INSERT INTO raw_materials (
                material_code,
                material_name,
                category_id,
                unit_id,
                grade,
                minimum_stock,
                reorder_level,
                standard_purchase_rate,
                status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
            `,
            [
                material_code,
                material_name.trim(),
                category_id || null,
                unit_id,
                grade || null,
                parseFloat(minimum_stock) || 0,
                parseFloat(reorder_level) || 0,
                parseFloat(standard_purchase_rate) || 0
            ]
        );

        const newMaterialId = insertRes.insertId;
        const initialQty = parseFloat(initial_stock_qty) || 0;

        // If initial stock is specified, create an opening batch
        if (initialQty > 0) {
            const batchNum = (batch_number && batch_number.trim()) || `OPN-${Date.now().toString().slice(-6)}`;
            const rate = parseFloat(standard_purchase_rate) || 0;
            const today = new Date().toISOString().slice(0, 10);

            const [batchRes] = await connection.query(
                `
                INSERT INTO material_batches (
                    material_id,
                    batch_number,
                    supplier_batch_number,
                    received_date,
                    quantity_received,
                    current_quantity,
                    purchase_rate,
                    qc_status
                ) VALUES (?, ?, 'OPENING-STOCK', ?, ?, ?, ?, 'APPROVED')
                `,
                [newMaterialId, batchNum, today, initialQty, initialQty, rate]
            );

            // Log in stock transactions
            await connection.query(
                `
                INSERT INTO stock_transactions (
                    material_id,
                    batch_id,
                    transaction_type,
                    reference_type,
                    quantity,
                    transaction_date,
                    remarks
                ) VALUES (?, ?, 'ADJUSTMENT_IN', 'OPENING_STOCK', ?, NOW(), ?)
                `,
                [
                    newMaterialId,
                    batchRes.insertId,
                    initialQty,
                    location_rack ? `Opening balance | Location: ${location_rack}` : "Initial opening inventory balance"
                ]
            );
        }

        await connection.commit();

        res.status(201).json({
            success: true,
            message: `Material "${material_name}" added to inventory successfully!`,
            data: { id: newMaterialId, material_code, material_name }
        });
    } catch (error) {
        await connection.rollback();
        console.error("CREATE RAW MATERIAL ERROR:", error);
        res.status(500).json({
            success: false,
            message: error.code === "ER_DUP_ENTRY" ? "Material code already exists. Please choose another code." : "Failed to create material",
            error: error.message
        });
    } finally {
        connection.release();
    }
};

// =========================================================
// 10. UPDATE RAW MATERIAL
// =========================================================
const updateRawMaterial = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            material_name,
            category_id,
            unit_id,
            grade,
            minimum_stock,
            reorder_level,
            standard_purchase_rate,
            status
        } = req.body;

        await pool.query(
            `
            UPDATE raw_materials SET
                material_name = COALESCE(?, material_name),
                category_id = COALESCE(?, category_id),
                unit_id = COALESCE(?, unit_id),
                grade = COALESCE(?, grade),
                minimum_stock = COALESCE(?, minimum_stock),
                reorder_level = COALESCE(?, reorder_level),
                standard_purchase_rate = COALESCE(?, standard_purchase_rate),
                status = COALESCE(?, status)
            WHERE id = ?
            `,
            [
                material_name,
                category_id,
                unit_id,
                grade,
                minimum_stock,
                reorder_level,
                standard_purchase_rate,
                status,
                id
            ]
        );

        res.json({
            success: true,
            message: "Material details updated successfully"
        });
    } catch (error) {
        console.error("UPDATE RAW MATERIAL ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to update material",
            error: error.message
        });
    }
};

// =========================================================
// 11. QUICK STOCK ADJUSTMENT (+ADD / -DEDUCT)
// =========================================================
const adjustStock = async (req, res) => {
    const connection = await pool.getConnection();
    await connection.beginTransaction();
    try {
        const { id } = req.params;
        const { type, quantity, reason, batch_number, remarks } = req.body;

        const qty = parseFloat(quantity);
        if (isNaN(qty) || qty <= 0) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "Please enter a valid positive quantity"
            });
        }

        const [matRows] = await connection.query("SELECT * FROM raw_materials WHERE id = ?", [id]);
        if (matRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: "Material not found" });
        }
        const material = matRows[0];

        if (type === "ADD") {
            // Create a new batch or add to existing batch
            const batchNum = (batch_number && batch_number.trim()) || `ADJ-${Date.now().toString().slice(-6)}`;
            const today = new Date().toISOString().slice(0, 10);
            const rate = material.standard_purchase_rate || 0;

            const [batchRes] = await connection.query(
                `
                INSERT INTO material_batches (
                    material_id, batch_number, received_date,
                    quantity_received, current_quantity, purchase_rate, qc_status
                ) VALUES (?, ?, ?, ?, ?, ?, 'APPROVED')
                `,
                [id, batchNum, today, qty, qty, rate]
            );

            await connection.query(
                `
                INSERT INTO stock_transactions (
                    material_id, batch_id, transaction_type, reference_type,
                    quantity, transaction_date, remarks
                ) VALUES (?, ?, 'ADJUSTMENT_IN', ?, ?, NOW(), ?)
                `,
                [id, batchRes.insertId, reason || "STOCK_ADJUSTMENT", qty, remarks || "Manual stock addition"]
            );
        } else if (type === "DEDUCT") {
            // Deduct from available batches (FIFO)
            const [batches] = await connection.query(
                `SELECT id, current_quantity FROM material_batches 
                 WHERE material_id = ? AND current_quantity > 0 AND qc_status = 'APPROVED'
                 ORDER BY received_date ASC, id ASC`,
                [id]
            );

            const totalAvail = batches.reduce((sum, b) => sum + parseFloat(b.current_quantity), 0);
            if (totalAvail < qty) {
                await connection.rollback();
                return res.status(400).json({
                    success: false,
                    message: `Cannot deduct ${qty}. Only ${totalAvail} available in stock.`
                });
            }

            let remainingToDeduct = qty;
            for (const b of batches) {
                if (remainingToDeduct <= 0) break;
                const batchQty = parseFloat(b.current_quantity);
                const deductFromThis = Math.min(batchQty, remainingToDeduct);

                await connection.query(
                    `UPDATE material_batches SET current_quantity = current_quantity - ? WHERE id = ?`,
                    [deductFromThis, b.id]
                );

                await connection.query(
                    `
                    INSERT INTO stock_transactions (
                        material_id, batch_id, transaction_type, reference_type,
                        quantity, transaction_date, remarks
                    ) VALUES (?, ?, 'ADJUSTMENT_OUT', ?, ?, NOW(), ?)
                    `,
                    [id, b.id, reason || "STOCK_ADJUSTMENT", deductFromThis, remarks || "Manual stock deduction"]
                );

                remainingToDeduct -= deductFromThis;
            }
        } else {
            await connection.rollback();
            return res.status(400).json({ success: false, message: "Type must be ADD or DEDUCT" });
        }

        await connection.commit();

        res.json({
            success: true,
            message: `Stock successfully ${type === "ADD" ? "added" : "deducted"} for ${material.material_name}!`
        });
    } catch (error) {
        await connection.rollback();
        console.error("ADJUST STOCK ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to adjust stock",
            error: error.message
        });
    } finally {
        connection.release();
    }
};

// =========================================================
// 12. DELETE RAW MATERIAL
// =========================================================
const deleteRawMaterial = async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query("UPDATE raw_materials SET status = 'INACTIVE' WHERE id = ?", [id]);
        res.json({
            success: true,
            message: "Material deleted successfully"
        });
    } catch (error) {
        console.error("DELETE RAW MATERIAL ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to delete material",
            error: error.message
        });
    }
};

module.exports = {
    getRawMaterials,
    getInventoryStats,
    getFormulations,
    getMixingBatches,
    createMixingBatch,
    issueBatchToLine,
    seedRawMaterials,
    getMetadata,
    createRawMaterial,
    updateRawMaterial,
    adjustStock,
    deleteRawMaterial
};
