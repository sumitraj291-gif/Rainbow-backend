const pool = require("../config/database");

// GET all customers
const getCustomers = async (req, res) => {
    try {
        const { search, status } = req.query;
        let query = `SELECT * FROM customers WHERE 1=1`;
        const params = [];

        if (status && status !== "ALL") {
            query += ` AND status = ?`;
            params.push(status);
        }

        if (search && search.trim()) {
            query += ` AND (customer_code LIKE ? OR company_name LIKE ? OR contact_person LIKE ? OR phone LIKE ? OR city LIKE ?)`;
            const term = `%${search.trim()}%`;
            params.push(term, term, term, term, term);
        }

        query += ` ORDER BY id DESC`;
        const [rows] = await pool.query(query, params);

        const [[stats]] = await pool.query(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) as active_count,
                SUM(CASE WHEN status = 'INACTIVE' THEN 1 ELSE 0 END) as inactive_count,
                COUNT(DISTINCT city) as city_count
            FROM customers
        `);

        res.json({
            success: true,
            count: rows.length,
            stats: stats || { total: rows.length, active_count: rows.length, inactive_count: 0, city_count: 0 },
            data: rows
        });

    } catch (error) {
        console.error("Get customers error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to fetch customers",
            error: error.message
        });
    }
};


// GET single customer
const getCustomerById = async (req, res) => {
    try {
        const { id } = req.params;

        const [rows] = await pool.query(
            `SELECT * FROM customers WHERE id = ?`,
            [id]
        );

        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Customer not found"
            });
        }

        res.json({
            success: true,
            data: rows[0]
        });

    } catch (error) {
        console.error("Get customer error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to fetch customer",
            error: error.message
        });
    }
};


// CREATE customer
const createCustomer = async (req, res) => {
    try {
        const {
            customer_code,
            company_name,
            contact_person,
            phone,
            email,
            gst_number,
            billing_address,
            shipping_address,
            city,
            state,
            pincode,
            credit_limit,
            payment_terms,
            status
        } = req.body;

        const finalCode = (customer_code && customer_code.trim())
            ? customer_code.trim()
            : `CUST-${Math.floor(1000 + Math.random() * 9000)}`;

        if (!company_name || !company_name.trim()) {
            return res.status(400).json({
                success: false,
                message: "Company name is required"
            });
        }

        const [result] = await pool.query(
            `
            INSERT INTO customers
            (
                customer_code,
                company_name,
                contact_person,
                phone,
                email,
                gst_number,
                billing_address,
                shipping_address,
                city,
                state,
                pincode,
                credit_limit,
                payment_terms,
                status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [
                finalCode,
                company_name.trim(),
                contact_person || null,
                phone || null,
                email || null,
                gst_number || null,
                billing_address || null,
                shipping_address || null,
                city || null,
                state || null,
                pincode || null,
                credit_limit || 0,
                payment_terms || null,
                status || "ACTIVE"
            ]
        );


        res.status(201).json({
            success: true,
            message: "Customer created successfully",
            customer_id: result.insertId,
            id: result.insertId,
            data: { id: result.insertId }
        });

    } catch (error) {

        console.error("Create customer error:", error);

        if (error.code === "ER_DUP_ENTRY") {
            return res.status(409).json({
                success: false,
                message: "Customer code already exists"
            });
        }

        res.status(500).json({
            success: false,
            message: "Failed to create customer",
            error: error.message
        });
    }
};


// UPDATE customer
const updateCustomer = async (req, res) => {
    try {

        const { id } = req.params;

        const {
            customer_code,
            company_name,
            contact_person,
            phone,
            email,
            gst_number,
            billing_address,
            shipping_address,
            city,
            state,
            pincode,
            credit_limit,
            payment_terms,
            status
        } = req.body;


        const [result] = await pool.query(
            `
            UPDATE customers
            SET
                customer_code = COALESCE(?, customer_code),
                company_name = COALESCE(?, company_name),
                contact_person = ?,
                phone = ?,
                email = ?,
                gst_number = ?,
                billing_address = ?,
                shipping_address = ?,
                city = ?,
                state = ?,
                pincode = ?,
                credit_limit = ?,
                payment_terms = ?,
                status = ?
            WHERE id = ?
            `,
            [
                customer_code,
                company_name,
                contact_person || null,
                phone || null,
                email || null,
                gst_number || null,
                billing_address || null,
                shipping_address || null,
                city || null,
                state || null,
                pincode || null,
                credit_limit || 0,
                payment_terms || null,
                status || "ACTIVE",
                id
            ]
        );


        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: "Customer not found"
            });
        }


        res.json({
            success: true,
            message: "Customer updated successfully"
        });

    } catch (error) {

        console.error("Update customer error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to update customer",
            error: error.message
        });
    }
};


// DELETE customer
const deleteCustomer = async (req, res) => {
    try {

        const { id } = req.params;

        const [result] = await pool.query(
            `DELETE FROM customers WHERE id = ?`,
            [id]
        );


        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: "Customer not found"
            });
        }


        res.json({
            success: true,
            message: "Customer deleted successfully"
        });

    } catch (error) {

        console.error("Delete customer error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to delete customer",
            error: error.message
        });
    }
};


module.exports = {
    getCustomers,
    getCustomerById,
    createCustomer,
    updateCustomer,
    deleteCustomer
};