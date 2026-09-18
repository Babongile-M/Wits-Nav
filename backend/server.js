require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");

const nodes = require("./nodes.json");

const server = express();
const PORT = process.env.PORT || 8080;

server.use(cors());


// ======================================================
// ROUTING SETTINGS
// ======================================================

// If Google's walking route finishes within 3 metres
// of the saved entrance, we treat it as effectively there.
const FINAL_APPROACH_MIN_METRES = 3;

// We only draw a straight final line to the entrance when
// Google's snapped endpoint is reasonably close.
//
// This prevents the map from drawing a fake line through
// buildings/walls if Google's pedestrian data is poor.
const MAX_DRAWN_FINAL_APPROACH_METRES = 40;


// ======================================================
// GENERAL HELPERS
// ======================================================

function normalise(value) {
    return typeof value === "string"
        ? value
            .trim()
            .toLowerCase()
            .replace(/\s+/g, " ")
        : "";
}


function hasCoordinates(location) {
    return Boolean(
        location &&
        Number.isFinite(location.lat) &&
        Number.isFinite(location.lng) &&
        location.lat >= -90 &&
        location.lat <= 90 &&
        location.lng >= -180 &&
        location.lng <= 180
    );
}


// Calculate straight-line GPS distance between two points.
function distanceInMetres(a, b) {
    const toRadians =
        degrees =>
            degrees * Math.PI / 180;

    const earthRadius =
        6371000;

    const latitudeDifference =
        toRadians(
            b.lat - a.lat
        );

    const longitudeDifference =
        toRadians(
            b.lng - a.lng
        );

    const h =
        Math.sin(
            latitudeDifference / 2
        ) ** 2 +

        Math.cos(
            toRadians(a.lat)
        ) *

        Math.cos(
            toRadians(b.lat)
        ) *

        Math.sin(
            longitudeDifference / 2
        ) ** 2;

    return (
        2 *
        earthRadius *
        Math.asin(
            Math.sqrt(
                Math.min(
                    1,
                    Math.max(
                        0,
                        h
                    )
                )
            )
        )
    );
}


// ======================================================
// EXACT DESTINATION / ENTRANCE
// ======================================================

// Prefer:
//
// "entrance": {
//     "lat": ...,
//     "lng": ...
// }
//
// If entrance is not present, use the existing
// building lat/lng.
//
// This means your old nodes.json still works.
function destinationPoint(node) {

    if (
        hasCoordinates(
            node?.entrance
        )
    ) {
        return {
            lat:
                node.entrance.lat,

            lng:
                node.entrance.lng
        };
    }


    if (
        hasCoordinates(node)
    ) {
        return {
            lat:
                node.lat,

            lng:
                node.lng
        };
    }


    return null;
}


// ======================================================
// LOCATION LOOKUP
// ======================================================

const locationLookup =
    new Map();


for (const node of nodes) {

    const searchNames = [
        node.id,
        node.name,
        ...(node.aliases || [])
    ];


    for (
        const name of searchNames
    ) {

        const key =
            normalise(name);


        if (!key) {
            continue;
        }


        const existing =
            locationLookup.get(
                key
            );


        if (
            existing &&
            existing !== node
        ) {
            throw new Error(
                `Duplicate location alias: ${name}`
            );
        }


        locationLookup.set(
            key,
            node
        );
    }
}


function findLocation(value) {
    return (
        locationLookup.get(
            normalise(value)
        ) || null
    );
}


// ======================================================
// GOOGLE HELPERS
// ======================================================

function googleWaypoint(location) {

    return {
        location: {
            latLng: {
                latitude:
                    location.lat,

                longitude:
                    location.lng
            }
        }
    };
}


function stepTarget(step) {

    const point =
        step.endLocation
            ?.latLng;


    const target = {
        lat:
            point?.latitude,

        lng:
            point?.longitude
    };


    if (
        !hasCoordinates(target)
    ) {
        throw new Error(
            "Google returned an invalid step endpoint."
        );
    }


    return target;
}


// ======================================================
// LOCATIONS ENDPOINT
// ======================================================

server.get(
    "/locations",
    (req, res) => {

        const locations =
            nodes
                .filter(
                    node =>
                        hasCoordinates(
                            node
                        ) ||

                        hasCoordinates(
                            node?.entrance
                        )
                )
                .map(
                    node => {

                        // Map marker position.
                        //
                        // If normal building coordinates
                        // exist, keep using them.
                        //
                        // Otherwise fall back to entrance.
                        const markerPoint =
                            hasCoordinates(
                                node
                            )
                                ? {
                                    lat:
                                        node.lat,

                                    lng:
                                        node.lng
                                }

                                : destinationPoint(
                                    node
                                );


                        const entrance =
                            destinationPoint(
                                node
                            );


                        return {
                            id:
                                node.id,

                            name:
                                node.name,

                            aliases:
                                node.aliases ||
                                [],

                            category:
                                node.category ||
                                "building",

                            lat:
                                markerPoint.lat,

                            lng:
                                markerPoint.lng,

                            entrance
                        };
                    }
                );


        res.json(
            locations
        );
    }
);


// ======================================================
// WALKING ROUTE ENDPOINT
// ======================================================

server.get(
    "/buildings",
    async (req, res) => {

        const {
            from,
            to,
            userLat,
            userLng
        } = req.query;


        // --------------------------------------------------
        // Destination validation
        // --------------------------------------------------

        if (
            !normalise(to)
        ) {
            return res
                .status(400)
                .json({
                    error:
                        "Please enter a destination."
                });
        }


        const endLocation =
            findLocation(to);


        if (!endLocation) {
            return res
                .status(404)
                .json({
                    code:
                        "LOCATION_NOT_FOUND",

                    error:
                        "Destination not found. Try WSS, SMH, FNB, CM or Matrix."
                });
        }


        // IMPORTANT:
        //
        // This is the coordinate where the app
        // must eventually declare arrival.
        const exactEntrance =
            destinationPoint(
                endLocation
            );


        if (!exactEntrance) {
            return res
                .status(400)
                .json({
                    error:
                        `${endLocation.name} does not have a valid entrance coordinate.`
                });
        }


        // --------------------------------------------------
        // Starting position
        // --------------------------------------------------

        let startLocation;


        if (
            userLat !== undefined ||
            userLng !== undefined
        ) {

            const validInput =
                typeof userLat ===
                    "string" &&

                typeof userLng ===
                    "string" &&

                userLat.trim() !==
                    "" &&

                userLng.trim() !==
                    "";


            if (!validInput) {
                return res
                    .status(400)
                    .json({
                        error:
                            "Both GPS latitude and longitude are required."
                    });
            }


            startLocation = {
                lat:
                    Number(userLat),

                lng:
                    Number(userLng)
            };


            if (
                !hasCoordinates(
                    startLocation
                )
            ) {
                return res
                    .status(400)
                    .json({
                        error:
                            "Your GPS coordinates are invalid. Please try again."
                    });
            }
        }

        else {

            const startNode =
                findLocation(
                    from
                );


            if (!startNode) {
                return res
                    .status(400)
                    .json({
                        error:
                            "Provide your live location or a recognised starting building."
                    });
            }


            startLocation =
                destinationPoint(
                    startNode
                );


            if (!startLocation) {
                return res
                    .status(400)
                    .json({
                        error:
                            `${startNode.name} does not have valid coordinates.`
                    });
            }
        }


        // --------------------------------------------------
        // API key
        // --------------------------------------------------

        const apiKey =
            (
                process.env
                    .GOOGLE_ROUTE_API ||

                process.env
                    .GOOGLE_ROUTES_API_KEY ||

                ""
            ).trim();


        if (!apiKey) {
            return res
                .status(503)
                .json({
                    code:
                        "ROUTING_NOT_CONFIGURED",

                    error:
                        "Walking navigation is not configured yet."
                });
        }


        // --------------------------------------------------
        // Google walking request
        // --------------------------------------------------

        try {

            const googleResponse =
                await axios.post(

                    "https://routes.googleapis.com/directions/v2:computeRoutes",

                    {
                        origin:
                            googleWaypoint(
                                startLocation
                            ),


                        // IMPORTANT:
                        //
                        // Google gets the exact saved
                        // entrance coordinate.
                        destination:
                            googleWaypoint(
                                exactEntrance
                            ),


                        travelMode:
                            "WALK",

                        languageCode:
                            "en",

                        units:
                            "METRIC",

                        polylineQuality:
                            "HIGH_QUALITY",

                        polylineEncoding:
                            "GEO_JSON_LINESTRING"
                    },

                    {
                        timeout:
                            12000,

                        headers: {
                            "Content-Type":
                                "application/json",

                            "X-Goog-Api-Key":
                                apiKey,

                            "X-Goog-FieldMask":
                                [
                                    "routes.distanceMeters",

                                    "routes.duration",

                                    "routes.polyline.geoJsonLinestring",

                                    "routes.legs.steps.distanceMeters",

                                    "routes.legs.steps.endLocation",

                                    "routes.legs.steps.navigationInstruction",

                                    "routes.warnings"
                                ].join(",")
                        }
                    }
                );


            const route =
                googleResponse
                    .data
                    .routes?.[0];


            if (!route) {
                return res
                    .status(404)
                    .json({
                        code:
                            "ROUTE_NOT_FOUND",

                        error:
                            "No walking route was found between these locations."
                    });
            }


            // ==================================================
            // ROUTE POLYLINE
            // ==================================================

            const coordinates =
                route
                    .polyline
                    ?.geoJsonLinestring
                    ?.coordinates;


            if (
                !Array.isArray(
                    coordinates
                ) ||

                coordinates.length <
                    2 ||

                !coordinates.every(
                    point =>
                        Array.isArray(
                            point
                        ) &&

                        point.length >=
                            2
                )
            ) {

                throw new Error(
                    "Google returned incomplete route geometry."
                );
            }


            // GeoJSON:
            //
            // [longitude, latitude]
            //
            // Google Maps:
            //
            // { lat, lng }
            const pathCoordinates =
                coordinates.map(
                    point => ({
                        lat:
                            point[1],

                        lng:
                            point[0]
                    })
                );


            if (
                !pathCoordinates.every(
                    hasCoordinates
                )
            ) {
                throw new Error(
                    "Google returned invalid route coordinates."
                );
            }


            // ==================================================
            // GOOGLE WALKING STEPS
            // ==================================================

            const rawSteps =
                (
                    route.legs ||
                    []
                )
                    .flatMap(
                        leg =>
                            leg.steps ||
                            []
                    );


            if (
                rawSteps.length ===
                0
            ) {
                throw new Error(
                    "Google returned no walking instructions."
                );
            }


            const navigationSteps =
                rawSteps.map(
                    step => {

                        const distance =
                            step.distanceMeters ??
                            0;


                        if (
                            !Number.isFinite(
                                distance
                            ) ||

                            distance <
                                0
                        ) {
                            throw new Error(
                                "Google returned an invalid step distance."
                            );
                        }


                        const instruction =
                            step
                                .navigationInstruction
                                ?.instructions
                                ?.trim();


                        return {
                            instruction:
                                instruction ||

                                `Follow the highlighted path for about ${Math.round(distance)} metres.`,


                            distanceMeters:
                                Math.round(
                                    distance
                                ),


                            target:
                                stepTarget(
                                    step
                                ),


                            isArrival:
                                false
                        };
                    }
                );


            // ==================================================
            // EXACT ENTRANCE FINAL APPROACH
            // ==================================================

            const lastGoogleStep =
                navigationSteps[
                    navigationSteps.length -
                    1
                ];


            // Google may snap the destination to the
            // nearest mapped pedestrian path.
            //
            // Calculate the gap between Google's route
            // endpoint and OUR exact saved entrance.
            const finalApproachDistance =
                distanceInMetres(
                    lastGoogleStep.target,
                    exactEntrance
                );


            // If Google's endpoint is more than 3 m away
            // from the entrance, add one more navigation
            // instruction to the REAL entrance.
            if (
                finalApproachDistance >
                FINAL_APPROACH_MIN_METRES
            ) {

                navigationSteps.push({
                    instruction:
                        `Continue to the entrance of ${endLocation.name}.`,

                    distanceMeters:
                        Math.round(
                            finalApproachDistance
                        ),

                    target: {
                        lat:
                            exactEntrance.lat,

                        lng:
                            exactEntrance.lng
                    },

                    isArrival:
                        false
                });
            }


            // ==================================================
            // ARRIVAL STEP
            // ==================================================

            // IMPORTANT:
            //
            // Arrival now targets exactEntrance.
            //
            // We DO NOT use Google's snapped endpoint.
            navigationSteps.push({
                instruction:
                    `You have arrived at the entrance of ${endLocation.name}.`,

                distanceMeters:
                    0,

                target: {
                    lat:
                        exactEntrance.lat,

                    lng:
                        exactEntrance.lng
                },

                isArrival:
                    true
            });


            // ==================================================
            // EXTEND MAP LINE TO ENTRANCE WHEN SAFE
            // ==================================================

            const lastPathPoint =
                pathCoordinates[
                    pathCoordinates.length -
                    1
                ];


            const pathGapToEntrance =
                distanceInMetres(
                    lastPathPoint,
                    exactEntrance
                );


            // Only append a straight final segment when
            // the entrance is nearby.
            //
            // If Google ends 100 m away, for example,
            // drawing a straight line could incorrectly
            // cut through a building.
            if (
                pathGapToEntrance >
                    FINAL_APPROACH_MIN_METRES &&

                pathGapToEntrance <=
                    MAX_DRAWN_FINAL_APPROACH_METRES
            ) {

                pathCoordinates.push({
                    lat:
                        exactEntrance.lat,

                    lng:
                        exactEntrance.lng
                });
            }


            // ==================================================
            // ROUTE TOTALS
            // ==================================================

            const durationSeconds =
                Number.parseFloat(
                    route.duration
                );


            const googleDistanceMeters =
                route.distanceMeters ??
                0;


            if (
                !Number.isFinite(
                    durationSeconds
                ) ||

                durationSeconds <
                    0 ||

                !Number.isFinite(
                    googleDistanceMeters
                ) ||

                googleDistanceMeters <
                    0
            ) {
                throw new Error(
                    "Google returned invalid route totals."
                );
            }


            // Include Google's snapped-endpoint ->
            // exact-entrance gap in the displayed distance.
            const totalDistanceMeters =
                googleDistanceMeters +

                Math.max(
                    0,
                    Math.round(
                        finalApproachDistance
                    )
                );


            // ==================================================
            // WARNINGS
            // ==================================================

            const walkingNotice =
                "Walking directions are in beta and may be missing sidewalks " +
                "or pedestrian paths. Use caution and follow campus signs.";


            const warnings = [
                walkingNotice,

                ...(
                    Array.isArray(
                        route.warnings
                    )

                        ? route.warnings

                        : []
                )
            ]
                .filter(
                    value =>
                        typeof value ===
                            "string" &&

                        value
                            .trim() !==
                            ""
                );


            if (
                pathGapToEntrance >
                MAX_DRAWN_FINAL_APPROACH_METRES
            ) {

                warnings.push(
                    "Google's mapped walking route stops noticeably away from the saved entrance. " +
                    "The final arrival target still uses the saved entrance coordinate."
                );
            }


            // ==================================================
            // SEND TO FRONTEND
            // ==================================================

            return res.json({

                title:
                    endLocation.name ||
                    to.trim(),


                duration:
                    `${Math.max(
                        1,
                        Math.ceil(
                            durationSeconds /
                            60
                        )
                    )} mins`,


                distance:
                    `${Math.round(
                        totalDistanceMeters
                    )} m`,


                directions:
                    navigationSteps.map(
                        step =>
                            step.instruction
                    ),


                navigationSteps,


                pathCoordinates,


                // Helpful for testing.
                exactEntrance,


                // Shows where Google actually
                // stopped the routable path.
                googleRouteEnd: {
                    ...lastGoogleStep.target
                },


                // Shows how far Google's snapped
                // point was from your entrance.
                finalApproachDistanceMeters:
                    Math.round(
                        finalApproachDistance
                    ),


                warnings: [
                    ...new Set(
                        warnings
                    )
                ]
            });
        }


        // ======================================================
        // ERRORS
        // ======================================================

        catch (error) {

            const upstreamStatus =
                error.response
                    ?.status;


            const googleError =
                error.response
                    ?.data
                    ?.error;


            console.error(
                "Google Routes request failed:",
                {
                    httpStatus:
                        upstreamStatus,

                    code:
                        googleError
                            ?.status ||

                        error.code ||

                        "INVALID_RESPONSE"
                }
            );


            if (
                error.code ===
                    "ECONNABORTED" ||

                error.code ===
                    "ETIMEDOUT"
            ) {

                return res
                    .status(504)
                    .json({
                        code:
                            "ROUTING_TIMEOUT",

                        error:
                            "Walking directions took too long. Please try again."
                    });
            }


            if (
                upstreamStatus ===
                    401 ||

                upstreamStatus ===
                    403
            ) {

                return res
                    .status(503)
                    .json({
                        code:
                            "ROUTING_CONFIGURATION_ERROR",

                        error:
                            "Walking navigation is unavailable because of a server configuration problem."
                    });
            }


            if (
                upstreamStatus ===
                429
            ) {

                return res
                    .status(503)
                    .json({
                        code:
                            "ROUTING_LIMIT_REACHED",

                        error:
                            "Walking navigation is temporarily unavailable. Please try again later."
                    });
            }


            if (
                googleError?.message
            ) {
                console.error(
                    "Google Routes message:",
                    googleError.message
                );
            }


            return res
                .status(502)
                .json({
                    code:
                        "ROUTING_FAILED",

                    error:
                        "Walking directions could not be loaded. Please try again."
                });
        }
    }
);


// ======================================================
// START SERVER
// ======================================================

server.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            `The server is running on port ${PORT}`
        );
    }
);