const pool = require("../config/database");

// =========================================================
// HELPER: GENERATE GRN NUMBER
// =========================================================
async function generateGRNNumber(connection) {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const prefix = `GRN-${today}-`;
    const [rows] = await connection.query(
        `SELECT grn_number FROM material_receipts WHERE grn_number LIKE ? ORDER BY id DESC LIMIT 1`,
        [`${prefix}%`]
    );

    let nextSeq = 1;
    if (rows.length > 0 && rows[0].grn_number) {
        const parts = rows[0].grn_number.split("-");
        const lastSeq = parseInt(parts[parts.length - 1], 10);
        if (!isNaN(lastSeq)) nextSeq = lastSeq + 1;
    }
    return `${prefix}${String(nextSeq).padStart(4, "0")}`;
}

// =========================================================
// 1. GET ALL MATERIAL RECEIPTS (GRNS)
// =========================================================
const getReceipts = async (req, res) => {
    try {
        const { search, status, from_date, to_date } = req.query;

        let query = `
            SELECT 
                mr.*,
                s.supplier_code,
                s.company_name AS supplier_name,
                s.city AS supplier_city,
                s.gst_number AS supplier_gst,
                COUNT(mri.id) AS item_count
            FROM material_receipts mr
            INNER JOIN suppliers s ON s.id = mr.supplier_id
            LEFT JOIN material_receipt_items mri ON mri.receipt_id = mr.id
            WHERE 1=1
        `;
        const params = [];

        if (status) {
            query += ` AND mr.status = ?`;
            params.push(status);
        }

        if (from_date) {
            query += ` AND mr.receipt_date >= ?`;
            params.push(from_date);
        }

        if (to_date) {
            query += ` AND mr.receipt_date <= ?`;
            params.push(to_date);
        }

        if (search) {
            query += ` AND (
                mr.grn_number LIKE ? OR 
                mr.invoice_number LIKE ? OR 
                mr.vehicle_number LIKE ? OR 
                s.company_name LIKE ? OR 
                mr.lr_number LIKE ?
            )`;
            const s = `%${search.trim()}%`;
            params.push(s, s, s, s, s);
        }

        query += ` GROUP BY mr.id ORDER BY mr.id DESC`;

        const [rows] = await pool.query(query, params);

        res.json({
            success: true,
            data: rows
        });
    } catch (error) {
        console.error("GET RECEIPTS ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch material receipts",
            error: error.message
        });
    }
};

// =========================================================
// 2. GET RECEIPT & INWARD STATS
// =========================================================
const getReceiptStats = async (req, res) => {
    try {
        const [overall] = await pool.query(`
            SELECT 
                COUNT(*) AS total_grns,
                COALESCE(SUM(weighbridge_net_kg), 0) AS total_received_kg,
                COALESCE(SUM(total_amount_inr), 0) AS total_inward_value_inr,
                COUNT(CASE WHEN status = 'QC_PENDING' THEN 1 END) AS pending_qc_count,
                COUNT(DISTINCT supplier_id) AS active_suppliers_count
            FROM material_receipts
        `);

        res.json({
            success: true,
            data: {
                total_grns: overall[0]?.total_grns || 0,
                total_received_kg: Number(overall[0]?.total_received_kg || 0).toFixed(2),
                total_received_mt: (Number(overall[0]?.total_received_kg || 0) / 1000).toFixed(2),
                total_inward_value_inr: Number(overall[0]?.total_inward_value_inr || 0).toFixed(2),
                pending_qc_count: overall[0]?.pending_qc_count || 0,
                active_suppliers_count: overall[0]?.active_suppliers_count || 0
            }
        });
    } catch (error) {
        console.error("GET RECEIPT STATS ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to load receipt statistics",
            error: error.message
        });
    }
};

// =========================================================
// 3. GET SINGLE RECEIPT WITH ITEMS (FOR PRINTABLE GRN)
// =========================================================
const getReceiptById = async (req, res) => {
    try {
        const { id } = req.params;

        const [receiptRows] = await pool.query(`
            SELECT 
                mr.*,
                s.supplier_code,
                s.company_name AS supplier_name,
                s.contact_person AS supplier_contact,
                s.phone AS supplier_phone,
                s.email AS supplier_email,
                s.gst_number AS supplier_gst,
                s.address AS supplier_address,
                s.city AS supplier_city,
                s.state AS supplier_state,
                s.pincode AS supplier_pincode,
                s.payment_terms
            FROM material_receipts mr
            INNER JOIN suppliers s ON s.id = mr.supplier_id
            WHERE mr.id = ?
            LIMIT 1
        `, [id]);

        if (receiptRows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Material receipt (GRN) not found"
            });
        }

        const receipt = receiptRows[0];

        // Fetch received items
        const [items] = await pool.query(`
            SELECT 
                mri.*,
                rm.material_code,
                rm.material_name,
                rm.grade,
                mc.name AS category_name,
                u.symbol AS unit_symbol
            FROM material_receipt_items mri
            INNER JOIN raw_materials rm ON rm.id = mri.material_id
            LEFT JOIN material_categories mc ON mc.id = rm.category_id
            LEFT JOIN units u ON u.id = rm.unit_id
            WHERE mri.receipt_id = ?
            ORDER BY mri.id ASC
        `, [id]);

        res.json({
            success: true,
            data: {
                ...receipt,
                items
            }
        });
    } catch (error) {
        console.error("GET RECEIPT BY ID ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to load receipt details",
            error: error.message
        });
    }
};

// =========================================================
// 4. GET SUPPLIERS LIST
// =========================================================
const getSuppliers = async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT * FROM suppliers WHERE status = 'ACTIVE' ORDER BY company_name ASC
        `);

        res.json({
            success: true,
            data: rows
        });
    } catch (error) {
        console.error("GET SUPPLIERS ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch suppliers",
            error: error.message
        });
    }
};

// =========================================================
// 5. CREATE MATERIAL RECEIPT (GRN) & INWARD TO STOCK
// =========================================================
const createReceipt = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const {
            supplier_id,
            receipt_date = new Date().toISOString().slice(0, 10),
            invoice_number,
            invoice_date = new Date().toISOString().slice(0, 10),
            supplier_challan_no,
            vehicle_number,
            weighbridge_gross_kg = 0,
            weighbridge_tare_kg = 0,
            transporter_name,
            lr_number,
            total_packages = 0,
            store_location = "MAIN-RAW-WH-01",
            status = "APPROVED",
            remarks,
            items = []
        } = req.body;

        if (!supplier_id) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "Please select chemical supplier."
            });
        }

        if (!invoice_number) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "Supplier tax invoice number is required."
            });
        }

        if (!items || items.length === 0) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "Please enter at least one received raw material item."
            });
        }

        const gross = parseFloat(weighbridge_gross_kg || 0);
        const tare = parseFloat(weighbridge_tare_kg || 0);
        const net = Math.max(0, gross - tare);

        // Calculate total amount
        let totalAmount = 0;
        for (const it of items) {
            const qty = parseFloat(it.received_quantity || 0);
            const rate = parseFloat(it.rate || 0);
            totalAmount += qty * rate;
        }

        const grn_number = await generateGRNNumber(connection);

        // Insert Receipt Header
        const [grnResult] = await connection.query(`
            INSERT INTO material_receipts (
                grn_number, supplier_id, receipt_date, invoice_number, invoice_date,
                supplier_challan_no, vehicle_number, weighbridge_gross_kg, weighbridge_tare_kg,
                weighbridge_net_kg, transporter_name, lr_number, total_packages,
                total_amount_inr, store_location, status, remarks
            ) VALUES (
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?, ?
            )
        `, [
            grn_number, supplier_id, receipt_date, invoice_number, invoice_date,
            supplier_challan_no || "", vehicle_number || "Direct Inward", gross, tare,
            net > 0 ? net : items.reduce((acc, i) => acc + parseFloat(i.received_quantity || 0), 0),
            transporter_name || "Supplier Transport", lr_number || "", total_packages,
            totalAmount, store_location, status, remarks || ""
        ]);

        const receiptId = grnResult.insertId;

        // Insert Items & Create Inventory Batches
        for (const it of items) {
            let matId = it.material_id;
            if (!matId && it.material_code) {
                const [mRows] = await connection.query("SELECT id FROM raw_materials WHERE material_code = ? LIMIT 1", [it.material_code]);
                matId = mRows[0]?.id;
            }
            if (!matId && it.material_name) {
                const [mRows] = await connection.query("SELECT id FROM raw_materials WHERE material_name LIKE ? LIMIT 1", [`%${it.material_name}%`]);
                matId = mRows[0]?.id;
            }
            if (!matId) {
                matId = 1;
            }

            const qty = parseFloat(it.received_quantity || 0);
            const rate = parseFloat(it.rate || 0);
            const itemTotal = qty * rate;
            const batchNo = it.batch_number || `BATCH-${grn_number}-${matId}`;

            await connection.query(`
                INSERT INTO material_receipt_items (
                    receipt_id, material_id, batch_number, package_type, number_of_packages,
                    received_quantity, accepted_quantity, rejected_quantity, rate,
                    total_item_amount, qc_status, moisture_pct, coa_attached
                ) VALUES (
                    ?, ?, ?, ?, ?,
                    ?, ?, 0, ?,
                    ?, ?, ?, ?
                )
            `, [
                receiptId, matId, batchNo, it.package_type || "BAGS", it.number_of_packages || 0,
                qty, qty, rate,
                itemTotal, it.qc_status || "APPROVED", it.moisture_pct || 0.10, it.coa_attached ? 1 : 0
            ]);

            // If approved, create/update material_batches lot
            if (status === "APPROVED" || it.qc_status === "APPROVED") {
                await connection.query(`
                    INSERT INTO material_batches (
                        material_id, supplier_id, batch_number, supplier_batch_number,
                        received_date, manufacturing_date, expiry_date,
                        quantity_received, current_quantity, purchase_rate, qc_status
                    ) VALUES (
                        ?, ?, ?, ?,
                        ?, ?, DATE_ADD(?, INTERVAL 2 YEAR),
                        ?, ?, ?, 'APPROVED'
                    )
                `, [
                    it.material_id, supplier_id, batchNo, it.supplier_batch_number || batchNo,
                    receipt_date, receipt_date, receipt_date,
                    qty, qty, rate
                ]);
            }
        }

        await connection.commit();

        res.status(201).json({
            success: true,
            message: `Goods Receipt Note ${grn_number} created and inventory updated!`,
            data: {
                id: receiptId,
                grn_number,
                total_amount_inr: totalAmount.toFixed(2),
                status
            }
        });
    } catch (error) {
        await connection.rollback();
        console.error("CREATE RECEIPT ERROR:", error);
        res.status(500).json({
            success: false,
            message: "Failed to record material receipt",
            error: error.message
        });
    } finally {
        connection.release();
    }
};

module.exports = {
    getReceipts,
    getReceiptStats,
    getReceiptById,
    getSuppliers,
    createReceipt
};
