require("dotenv").config(); // Load secret variables from .env locally.

const express = require("express");
const cors = require("cors");
const axios = require("axios");

const nodes = require("./nodes.json");

const server = express();

// Railway provides PORT automatically.
const PORT = process.env.PORT || 8080;

// Use your existing environment-variable name.
const GOOGLE_ROUTE_API = (
    process.env.GOOGLE_ROUTE_API || ""
).trim();

server.use(cors());

// ======================================================
// ROUTING SETTINGS
// ======================================================

// Reject routes that stop noticeably away from the saved pin.
// This does not prove that the saved pin is the correct entrance.
const MAX_DESTINATION_GAP_METRES = 25;

const GOOGLE_ROUTES_URL =
    "https://routes.googleapis.com/directions/v2:computeRoutes";

// ======================================================
// GENERAL HELPERS
// ======================================================

// Ignore capital letters and repeated spaces.
function normalise(value) {
    return typeof value === "string"
        ? value.trim().toLowerCase().replace(/\s+/g, " ")
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

// Straight-line distance between two coordinates.
// Used for checking endpoints, not for inventing walking paths.
function distanceInMetres(a, b) {
    const radians = degrees => degrees * Math.PI / 180;

    const latitudeDifference = radians(b.lat - a.lat);
    const longitudeDifference = radians(b.lng - a.lng);

    const h =
        Math.sin(latitudeDifference / 2) ** 2 +
        Math.cos(radians(a.lat)) *
        Math.cos(radians(b.lat)) *
        Math.sin(longitudeDifference / 2) ** 2;

    return 12742000 * Math.asin(
        Math.sqrt(Math.min(1, Math.max(0, h)))
    );
}

// Convert our coordinate format to Google's waypoint format.
function googleWaypoint(location) {
    return {
        location: {
            latLng: {
                latitude: location.lat,
                longitude: location.lng
            }
        }
    };
}

// Convert a Google location to the format used by our frontend.
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
// SAVED LOCATION LOOKUP
// ======================================================

const locationLookup = new Map();
const locationIds = new Set();

for (const node of nodes) {
    const id = normalise(node.id);

    if (!id || !normalise(node.name)) {
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

    if (
        node.aliases !== undefined &&
        !Array.isArray(node.aliases)
    ) {
        throw new Error(
            `Aliases must be an array: ${node.id}`
        );
    }

    const searchNames = [
        node.id,
        node.name,
        ...(node.aliases || [])
    ];

    for (const name of searchNames) {
        const key = normalise(name);

        if (!key) continue;

        const existing = locationLookup.get(key);

        if (existing && existing !== node) {
            throw new Error(
                `Duplicate location alias: ${name}`
            );
        }

        locationLookup.set(key, node);
    }
}

function findLocation(value) {
    return locationLookup.get(normalise(value)) || null;
}

// Prepare the public list once when the server starts.
const searchableLocations = nodes
    .filter(hasCoordinates)
    .map(node => ({
        id: node.id,
        name: node.name,
        aliases: node.aliases || [],
        category: node.category || "building",
        lat: node.lat,
        lng: node.lng
    }));

// ======================================================
// LOCATIONS ENDPOINT
// ======================================================

// Used by search suggestions and Quick Access markers.
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

    // --------------------------------------------------
    // Validate destination
    // --------------------------------------------------

    if (!normalise(to)) {
        return res.status(400).json({
            error: "Please enter a destination."
        });
    }

    const endLocation = findLocation(to);

    if (!endLocation) {
        return res.status(404).json({
            code: "LOCATION_NOT_FOUND",
            error:
                "Destination not found. Try WSS, SMH, FNB, CM or Matrix."
        });
    }

    if (!hasCoordinates(endLocation)) {
        return res.status(400).json({
            error:
                `${endLocation.name} is listed, but its coordinates have not been added yet.`
        });
    }

    // --------------------------------------------------
    // Validate starting position
    // --------------------------------------------------

    let startLocation;

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
                error:
                    "Your GPS coordinates are invalid. Please try again."
            });
        }
    } else {
        startLocation = findLocation(from);

        if (!startLocation) {
            return res.status(400).json({
                error:
                    "Provide your live location or a recognised starting building."
            });
        }

        if (!hasCoordinates(startLocation)) {
            return res.status(400).json({
                error:
                    `${startLocation.name} does not have coordinates yet.`
            });
        }
    }

    if (!GOOGLE_ROUTE_API) {
        return res.status(503).json({
            code: "ROUTING_NOT_CONFIGURED",
            error:
                "The server is missing its GOOGLE_ROUTE_API variable."
        });
    }

    try {
        // --------------------------------------------------
        // Request a Google walking route
        // --------------------------------------------------

        const googleResponse = await axios.post(
            GOOGLE_ROUTES_URL,

            {
                origin: googleWaypoint(startLocation),
                destination: googleWaypoint(endLocation),

                travelMode: "WALK",
                languageCode: "en",
                units: "METRIC",

                polylineQuality: "HIGH_QUALITY",
                polylineEncoding: "GEO_JSON_LINESTRING"
            },

            {
                timeout: 12000,

                headers: {
                    "Content-Type": "application/json",
                    "X-Goog-Api-Key": GOOGLE_ROUTE_API,

                    // Request only the data this app uses.
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

        const route = googleResponse.data.routes?.[0];

        if (!route) {
            return res.status(404).json({
                code: "ROUTE_NOT_FOUND",
                error:
                    "Google could not find a walking route between these locations."
            });
        }

        // --------------------------------------------------
        // Read the mapped route
        // --------------------------------------------------

        const coordinates =
            route.polyline?.geoJsonLinestring?.coordinates;

        if (
            !Array.isArray(coordinates) ||
            coordinates.length < 2
        ) {
            throw new Error(
                "Google returned incomplete route geometry."
            );
        }

        // GeoJSON uses [longitude, latitude].
        // Our frontend uses { lat, lng }.
        const pathCoordinates = coordinates.map(point => ({
            lat: point?.[1],
            lng: point?.[0]
        }));

        if (!pathCoordinates.every(hasCoordinates)) {
            throw new Error(
                "Google returned invalid route coordinates."
            );
        }

        const legs = route.legs;

        if (!Array.isArray(legs) || !legs.length) {
            throw new Error(
                "Google returned no route legs."
            );
        }

        const googleRouteStart = readGoogleLocation(
            legs[0].startLocation
        );

        const googleRouteEnd = readGoogleLocation(
            legs[legs.length - 1].endLocation
        );

        const destinationPoint = {
            lat: endLocation.lat,
            lng: endLocation.lng
        };

        const destinationGap = distanceInMetres(
            googleRouteEnd,
            destinationPoint
        );

        const originGap = distanceInMetres(
            startLocation,
            googleRouteStart
        );

        // Do not silently present a route ending far from the pin.
        if (destinationGap > MAX_DESTINATION_GAP_METRES) {
            return res.status(422).json({
                code: "DESTINATION_ENDPOINT_MISMATCH",

                error:
                    `Google's walking route stops ${Math.round(destinationGap)} metres from the saved location for ${endLocation.name}. Check this venue's pedestrian entrance coordinate.`,

                destination: destinationPoint,
                googleRouteEnd,

                destinationGapMeters:
                    Math.round(destinationGap)
            });
        }

        // --------------------------------------------------
        // Convert Google's instructions
        // --------------------------------------------------

        const rawSteps = legs.flatMap(
            leg => leg.steps || []
        );

        if (!rawSteps.length) {
            throw new Error(
                "Google returned no walking instructions."
            );
        }

        const navigationSteps = rawSteps.map(step => {
            const distance = step.distanceMeters ?? 0;

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
                    step.navigationInstruction
                        ?.instructions?.trim() ||
                    "Follow the highlighted walking path.",

                distanceMeters: Math.round(distance),

                // Google's instruction applies to this step.
                // Advance after reaching this step's end.
                target: readGoogleLocation(
                    step.endLocation
                ),

                isArrival: false
            };
        });

        // Separate final state for the frontend.
        // This is Google's mapped endpoint, not a verified doorway.
        navigationSteps.push({
            instruction:
                "You have reached the end of the mapped walking route. Check the building name and entrance signs.",

            distanceMeters: 0,
            target: googleRouteEnd,
            isArrival: true
        });

        // --------------------------------------------------
        // Route totals and notices
        // --------------------------------------------------

        const durationText = route.duration;

        if (
            typeof durationText !== "string" ||
            !/^\d+(?:\.\d+)?s$/.test(durationText)
        ) {
            throw new Error(
                "Google returned an invalid duration."
            );
        }

        const durationSeconds = Number(
            durationText.slice(0, -1)
        );

        const distanceMeters = route.distanceMeters ?? 0;

        if (
            !Number.isFinite(durationSeconds) ||
            !Number.isFinite(distanceMeters) ||
            distanceMeters < 0
        ) {
            throw new Error(
                "Google returned invalid route totals."
            );
        }

        const warnings = [
            "Walking directions are in beta and may be missing sidewalks or pedestrian paths. Use caution and follow campus signs.",

            ...(
                Array.isArray(route.warnings)
                    ? route.warnings.filter(
                        warning => typeof warning === "string"
                    )
                    : []
            )
        ];

        if (originGap > 15) {
            warnings.push(
                `Google's mapped route starts about ${Math.round(originGap)} metres from your supplied position.`
            );
        }

        if (destinationGap > 10) {
            warnings.push(
                `The mapped route ends about ${Math.round(destinationGap)} metres from the saved destination pin.`
            );
        }

        // Do not cache responses containing a user's route.
        res.set("Cache-Control", "no-store");

        return res.json({
            title: endLocation.name,

            duration:
                `${Math.max(1, Math.ceil(durationSeconds / 60))} mins`,

            distance:
                `${Math.round(distanceMeters)} m`,

            // Keep the existing frontend response format.
            directions: navigationSteps.map(
                step => step.instruction
            ),

            navigationSteps,
            pathCoordinates,

            // Additional fields for endpoint checks and debugging.
            destination: destinationPoint,
            googleRouteStart,
            googleRouteEnd,

            destinationGapMeters:
                Math.round(destinationGap),

            originGapMeters:
                Math.round(originGap),

            warnings: [...new Set(warnings)]
        });
    } catch (error) {
        const upstreamStatus = error.response?.status;
        const googleStatus =
            error.response?.data?.error?.status;

        // Do not log the entire Axios error.
        // It contains request headers, including the secret key.
        console.error("Google Routes request failed:", {
            httpStatus: upstreamStatus,
            code:
                googleStatus ||
                error.code ||
                "INVALID_RESPONSE"
        });

        if (
            error.code === "ECONNABORTED" ||
            error.code === "ETIMEDOUT"
        ) {
            return res.status(504).json({
                code: "ROUTING_TIMEOUT",
                error:
                    "Walking directions took too long. Please try again."
            });
        }

        if (
            upstreamStatus === 401 ||
            upstreamStatus === 403
        ) {
            return res.status(503).json({
                code: "ROUTING_CONFIGURATION_ERROR",
                error:
                    "Google routing is unavailable. Check the backend API key, its restrictions, enabled Routes API and billing."
            });
        }

        if (upstreamStatus === 429) {
            return res.status(503).json({
                code: "ROUTING_LIMIT_REACHED",
                error:
                    "Walking navigation is temporarily busy. Please try again shortly."
            });
        }

        return res.status(502).json({
            code: "ROUTING_FAILED",
            error:
                "Walking directions could not be loaded. Please try again."
        });
    }
});

// Start after building and validating the lookup.
server.listen(PORT, "0.0.0.0", () => {
    console.log(`The server is running on port ${PORT}`);
});