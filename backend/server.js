require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");

const nodes = require("./nodes.json");

const server = express();

const PORT = process.env.PORT || 8080;

/*
 * Supports your current Railway variable:
 *
 * GOOGLE_ROUTE_API
 *
 * You can later rename it to:
 *
 * GOOGLE_MAPS_API_KEY
 *
 * without changing the rest of the server.
 */
const GOOGLE_MAPS_API_KEY = (
    process.env.GOOGLE_MAPS_API_KEY ||
    process.env.GOOGLE_ROUTE_API ||
    ""
).trim();

const GOOGLE_ROUTES_URL =
    "https://routes.googleapis.com/directions/v2:computeRoutes";

/*
 * Used when we KNOW where the route should finish:
 *
 * - manually verified entrance
 * - raw coordinate destination
 *
 * We DO NOT apply this strict 25 m test to a Place ID
 * unless the location also has a verified entrance.
 */
const MAX_DESTINATION_GAP_METRES = 25;

/*
 * A Place ID may legitimately route to an entrance that is
 * some distance from the centre marker.
 *
 * This larger value is only used as a sanity warning.
 */
const PLACE_ID_MARKER_WARNING_METRES = 100;

server.use(cors());
server.use(express.json());


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


function hasPlaceId(location) {
    return Boolean(
        location &&
        typeof location.placeId === "string" &&
        location.placeId.trim() !== ""
    );
}


function getEntrance(location) {
    if (
        location &&
        location.entrance &&
        hasCoordinates(location.entrance)
    ) {
        return {
            lat: location.entrance.lat,
            lng: location.entrance.lng
        };
    }

    return null;
}


function getMarker(location) {
    if (!hasCoordinates(location)) {
        return null;
    }

    return {
        lat: location.lat,
        lng: location.lng
    };
}


/*
 * Straight-line distance between two coordinates.
 */
function distanceInMetres(a, b) {
    const radians = degrees =>
        degrees * Math.PI / 180;

    const latitudeDifference =
        radians(b.lat - a.lat);

    const longitudeDifference =
        radians(b.lng - a.lng);

    const h =
        Math.sin(latitudeDifference / 2) ** 2 +
        Math.cos(radians(a.lat)) *
        Math.cos(radians(b.lat)) *
        Math.sin(longitudeDifference / 2) ** 2;

    return 12742000 * Math.asin(
        Math.sqrt(
            Math.min(
                1,
                Math.max(0, h)
            )
        )
    );
}


// ======================================================
// GOOGLE WAYPOINT HELPERS
// ======================================================

function googleLatLngWaypoint(point) {
    return {
        location: {
            latLng: {
                latitude: point.lat,
                longitude: point.lng
            }
        }
    };
}


/*
 * Routing priority:
 *
 * 1. Verified pedestrian entrance
 * 2. Google Place ID
 * 3. Saved marker coordinate
 *
 * This is intentional.
 *
 * If we personally know the doorway students should use,
 * that is more useful for a campus walking application than
 * allowing Google to choose another entrance.
 */
function googleWaypoint(location) {
    const entrance = getEntrance(location);

    if (entrance) {
        return googleLatLngWaypoint(entrance);
    }

    if (hasPlaceId(location)) {
        return {
            placeId: location.placeId.trim()
        };
    }

    const marker = getMarker(location);

    if (marker) {
        return googleLatLngWaypoint(marker);
    }

    throw new Error(
        "Location has no usable routing target."
    );
}


/*
 * When checking whether Google's route endpoint is correct:
 *
 * verified entrance:
 *     compare against entrance
 *
 * Place ID without entrance:
 *     don't compare against centre marker because Google's
 *     selected entrance may legitimately differ
 *
 * coordinates only:
 *     compare against saved coordinates
 */
function getValidationPoint(location) {
    const entrance = getEntrance(location);

    if (entrance) {
        return entrance;
    }

    if (hasPlaceId(location)) {
        return null;
    }

    return getMarker(location);
}


function getRoutingMethod(location) {
    if (getEntrance(location)) {
        return "entrance";
    }

    if (hasPlaceId(location)) {
        return "placeId";
    }

    return "coordinates";
}


// ======================================================
// GOOGLE RESPONSE HELPERS
// ======================================================

function readGoogleLocation(location) {
    const point = {
        lat: location?.latLng?.latitude,
        lng: location?.latLng?.longitude
    };

    if (!hasCoordinates(point)) {
        throw new Error(
            "Google returned an invalid route location."
        );
    }

    return point;
}


// ======================================================
// VALIDATE NODES.JSON AT SERVER START
// ======================================================

if (!Array.isArray(nodes)) {
    throw new Error(
        "nodes.json must contain an array."
    );
}


const locationLookup = new Map();
const locationIds = new Set();


for (const node of nodes) {
    const id = normalise(node.id);
    const name = normalise(node.name);

    if (!id || !name) {
        throw new Error(
            "Every location must have an id and name."
        );
    }


    if (locationIds.has(id)) {
        throw new Error(
            `Duplicate location id: ${node.id}`
        );
    }

    locationIds.add(id);


    /*
     * Every node still needs lat/lng because these coordinates
     * are used for displaying the marker on the campus map.
     */
    if (!hasCoordinates(node)) {
        throw new Error(
            `Invalid marker coordinates: ${node.id}`
        );
    }


    if (
        node.aliases !== undefined &&
        !Array.isArray(node.aliases)
    ) {
        throw new Error(
            `Aliases must be an array: ${node.id}`
        );
    }


    if (
        node.placeId !== undefined &&
        node.placeId !== null &&
        typeof node.placeId !== "string"
    ) {
        throw new Error(
            `placeId must be a string or null: ${node.id}`
        );
    }


    if (
        node.entrance !== undefined &&
        node.entrance !== null &&
        !hasCoordinates(node.entrance)
    ) {
        throw new Error(
            `Invalid entrance coordinates: ${node.id}`
        );
    }


    const searchNames = [
        node.id,
        node.name,
        ...(node.aliases || [])
    ];


    for (const searchName of searchNames) {
        const key = normalise(searchName);

        if (!key) {
            continue;
        }

        const existing =
            locationLookup.get(key);

        if (
            existing &&
            existing !== node
        ) {
            throw new Error(
                `Duplicate location alias: ${searchName}`
            );
        }

        locationLookup.set(
            key,
            node
        );
    }
}


// ======================================================
// LOCATION LOOKUP
// ======================================================

function findLocation(value) {
    return (
        locationLookup.get(
            normalise(value)
        ) || null
    );
}


// ======================================================
// PUBLIC LOCATIONS LIST
// ======================================================

/*
 * We intentionally don't need to expose Google API
 * information to the frontend.
 *
 * The frontend continues receiving the same basic location
 * structure that it already uses.
 */
const searchableLocations = nodes.map(node => ({
    id: node.id,
    name: node.name,
    aliases: node.aliases || [],
    category: node.category || "building",
    lat: node.lat,
    lng: node.lng
}));


// ======================================================
// HEALTH CHECK
// ======================================================

server.get("/", (req, res) => {
    res.json({
        status: "ok",
        service: "Wits walking navigation"
    });
});


// ======================================================
// LOCATIONS ENDPOINT
// ======================================================

server.get("/locations", (req, res) => {
    res.json(searchableLocations);
});


// ======================================================
// WALKING DIRECTIONS ENDPOINT
// ======================================================

server.get("/buildings", async (req, res) => {

    const {
        from,
        to,
        userLat,
        userLng
    } = req.query;


    // ==================================================
    // DESTINATION
    // ==================================================

    if (!normalise(to)) {
        return res.status(400).json({
            code: "DESTINATION_REQUIRED",
            error:
                "Please enter a destination."
        });
    }


    const endLocation =
        findLocation(to);


    if (!endLocation) {
        return res.status(404).json({
            code: "LOCATION_NOT_FOUND",
            error:
                "Destination not found. Try WSS, SMH, FNB, CM, Matrix or another listed campus location."
        });
    }


    // ==================================================
    // STARTING POSITION
    // ==================================================

    let startLocation;
    let startIsLiveGps = false;


    /*
     * If either GPS value was supplied, both are required.
     */
    if (
        userLat !== undefined ||
        userLng !== undefined
    ) {

        const validInput =
            typeof userLat === "string" &&
            typeof userLng === "string" &&
            userLat.trim() !== "" &&
            userLng.trim() !== "";


        if (!validInput) {
            return res.status(400).json({
                code: "INVALID_GPS",
                error:
                    "Both GPS latitude and longitude are required."
            });
        }


        startLocation = {
            lat: Number(userLat),
            lng: Number(userLng)
        };


        if (!hasCoordinates(startLocation)) {
            return res.status(400).json({
                code: "INVALID_GPS",
                error:
                    "Your GPS coordinates are invalid. Please try again."
            });
        }


        startIsLiveGps = true;

    } else {

        if (!normalise(from)) {
            return res.status(400).json({
                code: "START_REQUIRED",
                error:
                    "Provide your live location or a recognised starting building."
            });
        }


        startLocation =
            findLocation(from);


        if (!startLocation) {
            return res.status(404).json({
                code: "START_LOCATION_NOT_FOUND",
                error:
                    "Starting location was not recognised."
            });
        }
    }


    // ==================================================
    // API CONFIGURATION
    // ==================================================

    if (!GOOGLE_MAPS_API_KEY) {
        return res.status(503).json({
            code: "ROUTING_NOT_CONFIGURED",
            error:
                "The server is missing its Google Maps API key."
        });
    }


    try {

        // ==============================================
        // ROUTES API REQUEST
        // ==============================================

        const googleResponse =
            await axios.post(
                GOOGLE_ROUTES_URL,

                {
                    origin:
                        googleWaypoint(
                            startLocation
                        ),

                    destination:
                        googleWaypoint(
                            endLocation
                        ),

                    travelMode: "WALK",

                    languageCode: "en",

                    units: "METRIC",

                    computeAlternativeRoutes: false,

                    polylineQuality:
                        "HIGH_QUALITY",

                    polylineEncoding:
                        "GEO_JSON_LINESTRING"
                },

                {
                    timeout: 12000,

                    headers: {
                        "Content-Type":
                            "application/json",

                        "X-Goog-Api-Key":
                            GOOGLE_MAPS_API_KEY,

                        "X-Goog-FieldMask": [
                            "routes.distanceMeters",
                            "routes.duration",
                            "routes.polyline.geoJsonLinestring",

                            "routes.legs.startLocation",
                            "routes.legs.endLocation",

                            "routes.legs.steps.distanceMeters",
                            "routes.legs.steps.endLocation",
                            "routes.legs.steps.navigationInstruction",

                            "routes.warnings"
                        ].join(",")
                    }
                }
            );


        // ==============================================
        // ROUTE EXISTS?
        // ==============================================

        const route =
            googleResponse.data.routes?.[0];


        if (!route) {
            return res.status(404).json({
                code: "ROUTE_NOT_FOUND",
                error:
                    "Google could not find a walking route between these locations."
            });
        }


        // ==============================================
        // POLYLINE
        // ==============================================

        const coordinates =
            route.polyline
                ?.geoJsonLinestring
                ?.coordinates;


        if (
            !Array.isArray(coordinates) ||
            coordinates.length < 2
        ) {
            throw new Error(
                "Google returned incomplete route geometry."
            );
        }


        /*
         * GeoJSON:
         *
         * [longitude, latitude]
         *
         * Leaflet/frontend:
         *
         * { lat, lng }
         */
        const pathCoordinates =
            coordinates.map(point => ({
                lat: point?.[1],
                lng: point?.[0]
            }));


        if (
            !pathCoordinates.every(
                hasCoordinates
            )
        ) {
            throw new Error(
                "Google returned invalid route coordinates."
            );
        }


        // ==============================================
        // ROUTE LEGS
        // ==============================================

        const legs = route.legs;


        if (
            !Array.isArray(legs) ||
            legs.length === 0
        ) {
            throw new Error(
                "Google returned no route legs."
            );
        }


        const googleRouteStart =
            readGoogleLocation(
                legs[0].startLocation
            );


        const googleRouteEnd =
            readGoogleLocation(
                legs[
                    legs.length - 1
                ].endLocation
            );


        // ==============================================
        // DESTINATION VALIDATION
        // ==============================================

        const destinationValidationPoint =
            getValidationPoint(
                endLocation
            );


        let destinationGap = null;


        if (destinationValidationPoint) {
            destinationGap =
                distanceInMetres(
                    googleRouteEnd,
                    destinationValidationPoint
                );


            /*
             * Strict validation is safe here because
             * destinationValidationPoint is either:
             *
             * - verified entrance
             * - saved coordinate without Place ID
             */
            if (
                destinationGap >
                MAX_DESTINATION_GAP_METRES
            ) {
                return res.status(422).json({
                    code:
                        "DESTINATION_ENDPOINT_MISMATCH",

                    error:
                        `Google's walking route stops ${Math.round(destinationGap)} metres from the expected arrival point for ${endLocation.name}. Check this venue's pedestrian entrance coordinate.`,

                    expectedDestination:
                        destinationValidationPoint,

                    googleRouteEnd,

                    destinationGapMeters:
                        Math.round(
                            destinationGap
                        )
                });
            }
        }


        // ==============================================
        // MARKER DISTANCE
        // ==============================================

        const destinationMarker =
            getMarker(endLocation);


        const markerGap =
            destinationMarker
                ? distanceInMetres(
                    googleRouteEnd,
                    destinationMarker
                )
                : null;


        // ==============================================
        // ORIGIN VALIDATION
        // ==============================================

        const originValidationPoint =
            startIsLiveGps
                ? getMarker(startLocation)
                : getValidationPoint(
                    startLocation
                );


        let originGap = null;


        if (originValidationPoint) {
            originGap =
                distanceInMetres(
                    originValidationPoint,
                    googleRouteStart
                );
        }


        // ==============================================
        // NAVIGATION STEPS
        // ==============================================

        const rawSteps =
            legs.flatMap(
                leg => leg.steps || []
            );


        if (!rawSteps.length) {
            throw new Error(
                "Google returned no walking instructions."
            );
        }


        const navigationSteps =
            rawSteps.map(step => {

                const distance =
                    step.distanceMeters ?? 0;


                if (
                    !Number.isFinite(distance) ||
                    distance < 0
                ) {
                    throw new Error(
                        "Google returned an invalid step distance."
                    );
                }


                return {
                    instruction:
                        step
                            .navigationInstruction
                            ?.instructions
                            ?.trim() ||
                        "Follow the highlighted walking path.",

                    distanceMeters:
                        Math.round(distance),

                    target:
                        readGoogleLocation(
                            step.endLocation
                        ),

                    isArrival: false
                };
            });


        /*
         * Separate final state for the frontend.
         */
        navigationSteps.push({
            instruction:
                `You have arrived at ${endLocation.name}. Check the building name and entrance signs.`,

            distanceMeters: 0,

            target:
                googleRouteEnd,

            isArrival: true
        });


        // ==============================================
        // DURATION
        // ==============================================

        const durationText =
            route.duration;


        if (
            typeof durationText !== "string" ||
            !/^\d+(?:\.\d+)?s$/.test(
                durationText
            )
        ) {
            throw new Error(
                "Google returned an invalid duration."
            );
        }


        const durationSeconds =
            Number(
                durationText.slice(
                    0,
                    -1
                )
            );


        // ==============================================
        // DISTANCE
        // ==============================================

        const distanceMeters =
            route.distanceMeters ?? 0;


        if (
            !Number.isFinite(
                durationSeconds
            ) ||
            !Number.isFinite(
                distanceMeters
            ) ||
            durationSeconds < 0 ||
            distanceMeters < 0
        ) {
            throw new Error(
                "Google returned invalid route totals."
            );
        }


        // ==============================================
        // WARNINGS
        // ==============================================

        const warnings = [
            "Walking directions may not contain every campus footpath. Follow campus signs and pedestrian access rules.",

            ...(
                Array.isArray(
                    route.warnings
                )
                    ? route.warnings.filter(
                        warning =>
                            typeof warning ===
                            "string"
                    )
                    : []
            )
        ];


        /*
         * Live GPS/raw coordinate start only.
         */
        if (
            originGap !== null &&
            originGap > 15
        ) {
            warnings.push(
                `Google's mapped route starts about ${Math.round(originGap)} metres from the supplied starting position.`
            );
        }


        /*
         * If routing using a verified entrance/raw coordinate,
         * give a smaller informational warning.
         */
        if (
            destinationGap !== null &&
            destinationGap > 10
        ) {
            warnings.push(
                `The mapped route ends about ${Math.round(destinationGap)} metres from the expected arrival point.`
            );
        }


        /*
         * When using a Place ID without our own verified
         * entrance, don't reject Google merely because its
         * entrance differs from our building-centre marker.
         *
         * But warn if the difference becomes suspiciously large.
         */
        if (
            getRoutingMethod(
                endLocation
            ) === "placeId" &&
            markerGap !== null &&
            markerGap >
                PLACE_ID_MARKER_WARNING_METRES
        ) {
            warnings.push(
                `Google's selected entrance is about ${Math.round(markerGap)} metres from the saved map marker for ${endLocation.name}. Verify that this Place ID refers to the correct building.`
            );
        }


        // ==============================================
        // RESPONSE
        // ==============================================

        res.set(
            "Cache-Control",
            "no-store"
        );


        return res.json({

            title:
                endLocation.name,

            duration:
                `${Math.max(
                    1,
                    Math.ceil(
                        durationSeconds / 60
                    )
                )} mins`,

            distance:
                `${Math.round(
                    distanceMeters
                )} m`,

            /*
             * Keeps your existing frontend-compatible array.
             */
            directions:
                navigationSteps.map(
                    step =>
                        step.instruction
                ),

            navigationSteps,

            pathCoordinates,


            // ------------------------------------------
            // DEBUG / ACCURACY INFORMATION
            // ------------------------------------------

            routingMethod:
                getRoutingMethod(
                    endLocation
                ),

            destination:
                destinationMarker,

            expectedArrival:
                destinationValidationPoint,

            googleRouteStart,

            googleRouteEnd,

            destinationGapMeters:
                destinationGap === null
                    ? null
                    : Math.round(
                        destinationGap
                    ),

            markerGapMeters:
                markerGap === null
                    ? null
                    : Math.round(
                        markerGap
                    ),

            originGapMeters:
                originGap === null
                    ? null
                    : Math.round(
                        originGap
                    ),

            warnings:
                [
                    ...new Set(
                        warnings
                    )
                ]
        });


    } catch (error) {

        // ==============================================
        // GOOGLE / NETWORK ERROR HANDLING
        // ==============================================

        const upstreamStatus =
            error.response?.status;

        const googleStatus =
            error.response
                ?.data
                ?.error
                ?.status;

        const googleMessage =
            error.response
                ?.data
                ?.error
                ?.message;


        /*
         * Do NOT console.log(error).
         *
         * Axios errors may contain the API-key header.
         */
        console.error(
            "Google Routes request failed:",
            {
                httpStatus:
                    upstreamStatus,

                code:
                    googleStatus ||
                    error.code ||
                    "INVALID_RESPONSE",

                message:
                    googleMessage ||
                    error.message
            }
        );


        if (
            error.code ===
                "ECONNABORTED" ||
            error.code ===
                "ETIMEDOUT"
        ) {
            return res.status(504).json({
                code:
                    "ROUTING_TIMEOUT",

                error:
                    "Walking directions took too long. Please try again."
            });
        }


        if (
            upstreamStatus === 400
        ) {
            return res.status(502).json({
                code:
                    "GOOGLE_REQUEST_INVALID",

                error:
                    "Google rejected the routing request. Check the destination Place ID or coordinates."
            });
        }


        if (
            upstreamStatus === 401 ||
            upstreamStatus === 403
        ) {
            return res.status(503).json({
                code:
                    "ROUTING_CONFIGURATION_ERROR",

                error:
                    "Google routing is unavailable. Check the backend API key, its restrictions, enabled Routes API and billing."
            });
        }


        if (
            upstreamStatus === 429
        ) {
            return res.status(503).json({
                code:
                    "ROUTING_LIMIT_REACHED",

                error:
                    "Walking navigation is temporarily busy. Please try again shortly."
            });
        }


        return res.status(502).json({
            code:
                "ROUTING_FAILED",

            error:
                "Walking directions could not be loaded. Please try again."
        });
    }
});


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

        console.log(
            `Loaded ${nodes.length} campus locations.`
        );
    }
);