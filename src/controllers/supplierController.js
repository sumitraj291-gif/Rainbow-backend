const pool = require("../config/database");

/**
 * GET ALL SUPPLIERS
 */
const getSuppliers = async (req, res) => {
    try {
        const { search = "", status = "" } = req.query;

        let query = `
            SELECT 
                s.*,
                COALESCE((
                    SELECT COUNT(*)
                    FROM material_receipts mr
                    WHERE mr.supplier_id = s.id
                ), 0) AS total_grns,
                COALESCE((
                    SELECT SUM(mr.total_amount_inr)
                    FROM material_receipts mr
                    WHERE mr.supplier_id = s.id
                ), 0) AS total_purchased_inr
            FROM suppliers s
            WHERE 1=1
        `;
        const params = [];

        if (status && status !== "ALL") {
            query += ` AND s.status = ?`;
            params.push(status);
        }

        if (search.trim()) {
            query += ` AND (
                s.supplier_code LIKE ? OR 
                s.company_name LIKE ? OR 
                s.contact_person LIKE ? OR 
                s.city LIKE ? OR 
                s.gst_number LIKE ?
            )`;
            const term = `%${search.trim()}%`;
            params.push(term, term, term, term, term);
        }

        query += ` ORDER BY s.id DESC`;

        const [rows] = await pool.query(query, params);

        // Stats summary
        const [statsRows] = await pool.query(`
            SELECT 
                COUNT(*) AS total,
                COUNT(CASE WHEN status = 'ACTIVE' THEN 1 END) AS active_count,
                COUNT(CASE WHEN status = 'INACTIVE' THEN 1 END) AS inactive_count,
                COUNT(DISTINCT city) AS city_count
            FROM suppliers
        `);

        res.json({
            success: true,
            data: rows,
            stats: statsRows[0] || { total: rows.length, active_count: rows.length, inactive_count: 0, city_count: 0 }
        });
    } catch (error) {
        console.error("Get Suppliers Error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch suppliers",
            error: error.message
        });
    }
};

/**
 * GET SINGLE SUPPLIER BY ID
 */
const getSupplierById = async (req, res) => {
    try {
        const { id } = req.params;

        const [rows] = await pool.query(
            `SELECT * FROM suppliers WHERE id = ? LIMIT 1`,
            [id]
        );

        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Supplier not found"
            });
        }

        const [receipts] = await pool.query(
            `SELECT id, grn_number, receipt_date, invoice_number, total_amount_inr, status 
             FROM material_receipts 
             WHERE supplier_id = ? 
             ORDER BY id DESC LIMIT 10`,
            [id]
        );

        res.json({
            success: true,
            data: {
                ...rows[0],
                recent_receipts: receipts
            }
        });
    } catch (error) {
        console.error("Get Supplier By ID Error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to load supplier details",
            error: error.message
        });
    }
};

/**
 * CREATE SUPPLIER
 */
const createSupplier = async (req, res) => {
    try {
        const {
            supplier_code,
            company_name,
            contact_person,
            phone,
            email,
            gst_number,
            address,
            city,
            state,
            pincode,
            payment_terms,
            status = "ACTIVE"
        } = req.body;

        if (!company_name || !company_name.trim()) {
            return res.status(400).json({
                success: false,
                message: "Supplier company name is required"
            });
        }

        const finalCode = (supplier_code && supplier_code.trim())
            ? supplier_code.trim().toUpperCase()
            : `SUP-${Math.floor(1000 + Math.random() * 9000)}`;

        const [result] = await pool.query(`
            INSERT INTO suppliers (
                supplier_code, company_name, contact_person, phone, email,
                gst_number, address, city, state, pincode, payment_terms, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            finalCode,
            company_name.trim(),
            contact_person || null,
            phone || null,
            email || null,
            gst_number || null,
            address || null,
            city || null,
            state || null,
            pincode || null,
            payment_terms || "Net 30 Days",
            status || "ACTIVE"
        ]);

        res.status(201).json({
            success: true,
            message: "Supplier created successfully",
            data: { id: result.insertId, supplier_code: finalCode }
        });
    } catch (error) {
        console.error("Create Supplier Error:", error);
        if (error.code === "ER_DUP_ENTRY") {
            return res.status(409).json({
                success: false,
                message: "Supplier code already exists"
            });
        }
        res.status(500).json({
            success: false,
            message: "Failed to create supplier",
            error: error.message
        });
    }
};

/**
 * UPDATE SUPPLIER
 */
const updateSupplier = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            supplier_code,
            company_name,
            contact_person,
            phone,
            email,
            gst_number,
            address,
            city,
            state,
            pincode,
            payment_terms,
            status
        } = req.body;

        if (!company_name || !company_name.trim()) {
            return res.status(400).json({
                success: false,
                message: "Supplier company name is required"
            });
        }

        const [result] = await pool.query(`
            UPDATE suppliers
            SET
                supplier_code = COALESCE(?, supplier_code),
                company_name = ?,
                contact_person = ?,
                phone = ?,
                email = ?,
                gst_number = ?,
                address = ?,
                city = ?,
                state = ?,
                pincode = ?,
                payment_terms = ?,
                status = ?
            WHERE id = ?
        `, [
            supplier_code ? supplier_code.trim().toUpperCase() : null,
            company_name.trim(),
            contact_person || null,
            phone || null,
            email || null,
            gst_number || null,
            address || null,
            city || null,
            state || null,
            pincode || null,
            payment_terms || "Net 30 Days",
            status || "ACTIVE",
            id
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: "Supplier not found"
            });
        }

        res.json({
            success: true,
            message: "Supplier updated successfully"
        });
    } catch (error) {
        console.error("Update Supplier Error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to update supplier",
            error: error.message
        });
    }
};

/**
 * DELETE SUPPLIER
 */
const deleteSupplier = async (req, res) => {
    try {
        const { id } = req.params;

        // Check if supplier is referenced in material receipts
        const [receipts] = await pool.query(
            `SELECT id FROM material_receipts WHERE supplier_id = ? LIMIT 1`,
            [id]
        );

        if (receipts.length > 0) {
            return res.status(400).json({
                success: false,
                message: "Cannot delete supplier with existing Material Receipts (GRN). Mark as INACTIVE instead."
            });
        }

        const [result] = await pool.query(
            `DELETE FROM suppliers WHERE id = ?`,
            [id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: "Supplier not found"
            });
        }

        res.json({
            success: true,
            message: "Supplier deleted successfully"
        });
    } catch (error) {
        console.error("Delete Supplier Error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to delete supplier",
            error: error.message
        });
    }
};

module.exports = {
    getSuppliers,
    getSupplierById,
    createSupplier,
    updateSupplier,
    deleteSupplier
};
