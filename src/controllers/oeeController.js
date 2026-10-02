const pool = require("../config/database");

/*
=========================================================
OEE REPORT CONTROLLER
=========================================================

OEE is calculated from actual production_entries.

Availability
= Run Time / Planned Production Time × 100

Performance
= Total Output / Ideal Output × 100

Quality
= Good Output / Total Output × 100

OEE
= Availability × Performance × Quality

Standard Output/Hour comes from Product Routing.

=========================================================
*/


/*
=========================================================
GET OEE FILTER OPTIONS
=========================================================
*/

const getOEEOptions = async (req, res) => {
    try {
        const [machines] = await pool.query(`
            SELECT
                id,
                machine_code,
                machine_name,
                status
            FROM machines
            ORDER BY machine_code, machine_name
        `);

        const [shifts] = await pool.query(`
            SELECT DISTINCT shift
            FROM production_entries
            WHERE shift IS NOT NULL
            ORDER BY shift
        `);

        return res.json({
            success: true,
            data: {
                machines,
                shifts: shifts.map(row => row.shift)
            }
        });

    } catch (error) {
        console.error("OEE OPTIONS ERROR:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to load OEE options",
            error: error.message
        });
    }
};


/*
=========================================================
GET OEE REPORT
=========================================================
*/

const getOEEReport = async (req, res) => {
    try {

        const {
            from,
            to,
            machine_id = "",
            shift = ""
        } = req.query;


        /*
        -------------------------------------------------
        VALIDATE DATES
        -------------------------------------------------
        */

        if (!from || !to) {
            return res.status(400).json({
                success: false,
                message: "From and To dates are required"
            });
        }

        if (from > to) {
            return res.status(400).json({
                success: false,
                message: "From date cannot be after To date"
            });
        }


        /*
        -------------------------------------------------
        BUILD FILTER
        -------------------------------------------------
        */

        let where = `
            WHERE pe.production_date BETWEEN ? AND ?
        `;

        const params = [from, to];


        if (machine_id) {
            where += `
                AND pe.machine_id = ?
            `;

            params.push(machine_id);
        }


        if (shift) {
            where += `
                AND pe.shift = ?
            `;

            params.push(shift);
        }


        /*
        -------------------------------------------------
        GET PRODUCTION ENTRIES
        -------------------------------------------------

        IMPORTANT:

        Product ID comes from:

        production_orders.product_id

        NOT:

        products.product_id

        -------------------------------------------------
        */

        const [rows] = await pool.query(
            `
            SELECT

                pe.id,
                pe.production_order_id,
                pe.machine_id,
                pe.operator_id,
                pe.production_date,
                pe.shift,
                pe.start_time,
                pe.end_time,

                COALESCE(
                    pe.input_quantity,
                    0
                ) AS input_quantity,

                COALESCE(
                    pe.good_quantity,
                    0
                ) AS good_quantity,

                COALESCE(
                    pe.rejected_quantity,
                    0
                ) AS rejected_quantity,

                COALESCE(
                    pe.wastage_quantity,
                    0
                ) AS wastage_quantity,

                COALESCE(
                    pe.downtime_minutes,
                    0
                ) AS downtime_minutes,


                /*
                -----------------------------------------
                PRODUCTION ORDER
                -----------------------------------------
                */

                po.production_order_number,

                /*
                IMPORTANT:
                product_id belongs to production_orders
                */

                po.product_id AS product_id,


                /*
                -----------------------------------------
                PRODUCT
                -----------------------------------------
                */

                p.product_code,
                p.product_name,


                /*
                -----------------------------------------
                MACHINE
                -----------------------------------------
                */

                m.machine_code,
                m.machine_name,


                /*
                -----------------------------------------
                STANDARD OUTPUT RATE
                -----------------------------------------

                Get the highest valid standard output
                configured for:

                Product
                +
                Machine

                through Product Routing.

                -----------------------------------------
                */

                (
                    SELECT MAX(
                        pp.standard_output_per_hour
                    )

                    FROM product_processes pp

                    INNER JOIN processes pr
                        ON pr.id = pp.process_id

                    WHERE
                        pp.product_id = po.product_id

                        AND pp.machine_id = pe.machine_id

                        AND pp.standard_output_per_hour IS NOT NULL

                        AND pp.standard_output_per_hour > 0

                        AND pr.status = 'ACTIVE'

                ) AS standard_output_per_hour


            FROM production_entries pe


            /*
            -----------------------------------------
            PRODUCTION ORDER JOIN
            -----------------------------------------
            */

            LEFT JOIN production_orders po
                ON po.id = pe.production_order_id


            /*
            -----------------------------------------
            PRODUCT JOIN
            -----------------------------------------
            */

            LEFT JOIN products p
                ON p.id = po.product_id


            /*
            -----------------------------------------
            MACHINE JOIN
            -----------------------------------------
            */

            LEFT JOIN machines m
                ON m.id = pe.machine_id


            ${where}


            ORDER BY
                pe.production_date DESC,
                pe.start_time DESC,
                pe.id DESC

            `,
            params
        );


        /*
        =================================================
        CALCULATE ENTRY-WISE OEE
        =================================================
        */

        const detail = rows.map(row => {

            /*
            ---------------------------------------------
            START / END TIME
            ---------------------------------------------
            */

            const start = row.start_time
                ? new Date(row.start_time).getTime()
                : null;

            const end = row.end_time
                ? new Date(row.end_time).getTime()
                : null;


            /*
            ---------------------------------------------
            PLANNED PRODUCTION TIME
            ---------------------------------------------
            */

            let plannedMinutes = 0;

            if (
                Number.isFinite(start) &&
                Number.isFinite(end) &&
                end >= start
            ) {
                plannedMinutes =
                    (end - start) / 60000;
            }


            /*
            ---------------------------------------------
            DOWNTIME
            ---------------------------------------------
            */

            const downtimeMinutes =
                Math.max(
                    Number(
                        row.downtime_minutes || 0
                    ),
                    0
                );


            /*
            ---------------------------------------------
            RUN TIME
            ---------------------------------------------
            */

            const runMinutes =
                Math.max(
                    plannedMinutes -
                    downtimeMinutes,
                    0
                );


            /*
            ---------------------------------------------
            OUTPUT
            ---------------------------------------------
            */

            const inputQuantity =
                Number(
                    row.input_quantity || 0
                );

            const goodQuantity =
                Number(
                    row.good_quantity || 0
                );

            const rejectedQuantity =
                Number(
                    row.rejected_quantity || 0
                );

            const wastageQuantity =
                Number(
                    row.wastage_quantity || 0
                );


            /*
            Total Output

            Good + Rejected + Wastage
            */

            const totalOutput =
                goodQuantity +
                rejectedQuantity +
                wastageQuantity;


            /*
            ---------------------------------------------
            STANDARD RATE
            ---------------------------------------------
            */

            const standardRate =
                Number(
                    row.standard_output_per_hour || 0
                );


            /*
            ---------------------------------------------
            IDEAL OUTPUT
            ---------------------------------------------

            Example:

            Standard rate = 20 rolls/hour

            Run time = 50 minutes

            Ideal output:

            20 × 50 / 60
            = 16.67 rolls

            ---------------------------------------------
            */

            const idealOutput =
                standardRate > 0
                    ? standardRate *
                      (runMinutes / 60)
                    : 0;


            /*
            ---------------------------------------------
            AVAILABILITY
            ---------------------------------------------
            */

            const availability =
                plannedMinutes > 0
                    ? (
                        runMinutes /
                        plannedMinutes
                    ) * 100
                    : null;


            /*
            ---------------------------------------------
            PERFORMANCE
            ---------------------------------------------

            Performance uses TOTAL OUTPUT.

            ---------------------------------------------
            */

            const performance =
                idealOutput > 0
                    ? (
                        totalOutput /
                        idealOutput
                    ) * 100
                    : null;


            /*
            ---------------------------------------------
            QUALITY
            ---------------------------------------------
            */

            const quality =
                totalOutput > 0
                    ? (
                        goodQuantity /
                        totalOutput
                    ) * 100
                    : null;


            /*
            ---------------------------------------------
            OEE
            ---------------------------------------------
            */

            const oee =
                availability !== null &&
                performance !== null &&
                quality !== null

                    ? (
                        availability *
                        performance *
                        quality
                    ) / 10000

                    : null;


            return {

                ...row,

                input_quantity:
                    Number(
                        inputQuantity.toFixed(3)
                    ),

                planned_minutes:
                    Number(
                        plannedMinutes.toFixed(2)
                    ),

                run_minutes:
                    Number(
                        runMinutes.toFixed(2)
                    ),

                total_output:
                    Number(
                        totalOutput.toFixed(3)
                    ),

                ideal_output:
                    Number(
                        idealOutput.toFixed(3)
                    ),

                availability:
                    availability === null
                        ? null
                        : Number(
                            availability.toFixed(2)
                        ),

                performance:
                    performance === null
                        ? null
                        : Number(
                            performance.toFixed(2)
                        ),

                quality:
                    quality === null
                        ? null
                        : Number(
                            quality.toFixed(2)
                        ),

                oee:
                    oee === null
                        ? null
                        : Number(
                            oee.toFixed(2)
                        )
            };
        });


        /*
        =================================================
        OVERALL SUMMARY
        =================================================
        */

        const sum = field => {

            return detail.reduce(
                (total, row) => {

                    return total +
                        Number(
                            row[field] || 0
                        );

                },
                0
            );
        };


        const plannedMinutes =
            sum("planned_minutes");

        const runMinutes =
            sum("run_minutes");

        const downtimeMinutes =
            sum("downtime_minutes");

        const inputQuantity =
            sum("input_quantity");

        const goodQuantity =
            sum("good_quantity");

        const rejectedQuantity =
            sum("rejected_quantity");

        const wastageQuantity =
            sum("wastage_quantity");

        const totalOutput =
            sum("total_output");

        const idealOutput =
            sum("ideal_output");


        /*
        ---------------------------------------------
        OVERALL AVAILABILITY
        ---------------------------------------------
        */

        const availability =
            plannedMinutes > 0
                ? (
                    runMinutes /
                    plannedMinutes
                ) * 100
                : null;


        /*
        ---------------------------------------------
        OVERALL PERFORMANCE
        ---------------------------------------------
        */

        const performance =
            idealOutput > 0
                ? (
                    totalOutput /
                    idealOutput
                ) * 100
                : null;


        /*
        ---------------------------------------------
        OVERALL QUALITY
        ---------------------------------------------
        */

        const quality =
            totalOutput > 0
                ? (
                    goodQuantity /
                    totalOutput
                ) * 100
                : null;


        /*
        ---------------------------------------------
        OVERALL OEE
        ---------------------------------------------
        */

        const oee =
            availability !== null &&
            performance !== null &&
            quality !== null

                ? (
                    availability *
                    performance *
                    quality
                ) / 10000

                : null;


        /*
        =================================================
        MACHINE-WISE OEE
        =================================================
        */

        const machineMap =
            new Map();


        detail.forEach(row => {

            const key =
                row.machine_id ||
                "unassigned";


            if (!machineMap.has(key)) {

                machineMap.set(
                    key,
                    {

                        machine_id:
                            row.machine_id,

                        machine_code:
                            row.machine_code ||
                            "Unassigned",

                        machine_name:
                            row.machine_name ||
                            "Unassigned",


                        planned_minutes: 0,

                        run_minutes: 0,

                        downtime_minutes: 0,


                        input_quantity: 0,

                        good_quantity: 0,

                        rejected_quantity: 0,

                        wastage_quantity: 0,

                        total_output: 0,

                        ideal_output: 0

                    }
                );
            }


            const machine =
                machineMap.get(key);


            machine.planned_minutes +=
                Number(
                    row.planned_minutes || 0
                );


            machine.run_minutes +=
                Number(
                    row.run_minutes || 0
                );


            machine.downtime_minutes +=
                Number(
                    row.downtime_minutes || 0
                );


            machine.input_quantity +=
                Number(
                    row.input_quantity || 0
                );


            machine.good_quantity +=
                Number(
                    row.good_quantity || 0
                );


            machine.rejected_quantity +=
                Number(
                    row.rejected_quantity || 0
                );


            machine.wastage_quantity +=
                Number(
                    row.wastage_quantity || 0
                );


            machine.total_output +=
                Number(
                    row.total_output || 0
                );


            machine.ideal_output +=
                Number(
                    row.ideal_output || 0
                );

        });


        /*
        =================================================
        MACHINE-WISE CALCULATION
        =================================================
        */

        const machineWise =
            Array.from(
                machineMap.values()
            ).map(machine => {


                const machineAvailability =
                    machine.planned_minutes > 0

                        ? (
                            machine.run_minutes /
                            machine.planned_minutes
                        ) * 100

                        : null;


                const machinePerformance =
                    machine.ideal_output > 0

                        ? (
                            machine.total_output /
                            machine.ideal_output
                        ) * 100

                        : null;


                const machineQuality =
                    machine.total_output > 0

                        ? (
                            machine.good_quantity /
                            machine.total_output
                        ) * 100

                        : null;


                const machineOEE =
                    machineAvailability !== null &&
                    machinePerformance !== null &&
                    machineQuality !== null

                        ? (
                            machineAvailability *
                            machinePerformance *
                            machineQuality
                        ) / 10000

                        : null;


                return {

                    ...machine,


                    planned_minutes:
                        Number(
                            machine.planned_minutes.toFixed(2)
                        ),


                    run_minutes:
                        Number(
                            machine.run_minutes.toFixed(2)
                        ),


                    downtime_minutes:
                        Number(
                            machine.downtime_minutes.toFixed(2)
                        ),


                    input_quantity:
                        Number(
                            machine.input_quantity.toFixed(3)
                        ),


                    good_quantity:
                        Number(
                            machine.good_quantity.toFixed(3)
                        ),


                    rejected_quantity:
                        Number(
                            machine.rejected_quantity.toFixed(3)
                        ),


                    wastage_quantity:
                        Number(
                            machine.wastage_quantity.toFixed(3)
                        ),


                    total_output:
                        Number(
                            machine.total_output.toFixed(3)
                        ),


                    ideal_output:
                        Number(
                            machine.ideal_output.toFixed(3)
                        ),


                    availability:
                        machineAvailability === null
                            ? null
                            : Number(
                                machineAvailability.toFixed(2)
                            ),


                    performance:
                        machinePerformance === null
                            ? null
                            : Number(
                                machinePerformance.toFixed(2)
                            ),


                    quality:
                        machineQuality === null
                            ? null
                            : Number(
                                machineQuality.toFixed(2)
                            ),


                    oee:
                        machineOEE === null
                            ? null
                            : Number(
                                machineOEE.toFixed(2)
                            )

                };

            });


        /*
        =================================================
        RESPONSE
        =================================================
        */

        return res.json({

            success: true,

            data: {

                filters: {

                    from,

                    to,

                    machine_id:
                        machine_id || null,

                    shift:
                        shift || null

                },


                summary: {

                    entries:
                        detail.length,


                    planned_minutes:
                        Number(
                            plannedMinutes.toFixed(2)
                        ),


                    run_minutes:
                        Number(
                            runMinutes.toFixed(2)
                        ),


                    downtime_minutes:
                        Number(
                            downtimeMinutes.toFixed(2)
                        ),


                    input_quantity:
                        Number(
                            inputQuantity.toFixed(3)
                        ),


                    good_quantity:
                        Number(
                            goodQuantity.toFixed(3)
                        ),


                    rejected_quantity:
                        Number(
                            rejectedQuantity.toFixed(3)
                        ),


                    wastage_quantity:
                        Number(
                            wastageQuantity.toFixed(3)
                        ),


                    total_output:
                        Number(
                            totalOutput.toFixed(3)
                        ),


                    ideal_output:
                        Number(
                            idealOutput.toFixed(3)
                        ),


                    availability:
                        availability === null
                            ? null
                            : Number(
                                availability.toFixed(2)
                            ),


                    performance:
                        performance === null
                            ? null
                            : Number(
                                performance.toFixed(2)
                            ),


                    quality:
                        quality === null
                            ? null
                            : Number(
                                quality.toFixed(2)
                            ),


                    oee:
                        oee === null
                            ? null
                            : Number(
                                oee.toFixed(2)
                            ),


                    standard_rate_available:
                        idealOutput > 0

                },


                machine_wise:
                    machineWise,


                entries:
                    detail

            }

        });

    } catch (error) {

        console.error(
            "OEE REPORT ERROR:",
            error
        );

        return res.status(500).json({

            success: false,

            message:
                "Unable to generate OEE report",

            error:
                error.message

        });

    }
};


/*
=========================================================
EXPORT
=========================================================
*/

module.exports = {
    getOEEOptions,
    getOEEReport
};