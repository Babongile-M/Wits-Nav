require("dotenv").config(); // Load backend secrets from .env locally.
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const nodes = require("./nodes.json");

const server = express();
const PORT = process.env.PORT || 8080;

const API_KEY = (
    process.env.GOOGLE_ROUTES_API_KEY ||
    process.env.GOOGLE_ROUTE_API ||
    ""
).trim();

server.use(cors());

// ======================================================
// GENERAL HELPERS
// ======================================================

function normalise(value) {
    return typeof value === "string"
        ? value.trim().toLowerCase().replace(/\s+/g, " ")
        : "";
}

function hasCoordinates(point) {
    return Boolean(
        point &&
        Number.isFinite(point.lat) &&
        Number.isFinite(point.lng) &&
        Math.abs(point.lat) <= 90 &&
        Math.abs(point.lng) <= 180
    );
}

function distanceInMetres(a, b) {
    const rad = value => value * Math.PI / 180;

    const h =
        Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
        Math.cos(rad(a.lat)) *
        Math.cos(rad(b.lat)) *
        Math.sin(rad(b.lng - a.lng) / 2) ** 2;

    return 12742000 * Math.asin(
        Math.sqrt(Math.min(1, Math.max(0, h)))
    );
}

function verifiedEntrance(node) {
    return (
        node.entranceVerified === true &&
        hasCoordinates(node.entrance)
    );
}

function destinationPoint(node) {
    return verifiedEntrance(node)
        ? node.entrance
        : node;
}

function coordinateWaypoint(point) {
    return {
        location: {
            latLng: {
                latitude: point.lat,
                longitude: point.lng
            }
        }
    };
}

function nodeWaypoint(node) {
    // Use a checked pedestrian entrance first.
    if (verifiedEntrance(node)) {
        return coordinateWaypoint(node.entrance);
    }

    // Only use a Google Place ID after checking that it
    // belongs to this exact venue.
    //
    // The old generator's results are NOT automatically trusted.
    if (
        node.placeIdVerified === true &&
        node.googlePlaceId
    ) {
        return {
            placeId: node.googlePlaceId
        };
    }

    // Existing nodes.json still works.
    return coordinateWaypoint(node);
}

function googlePoint(location) {
    const point = {
        lat: location?.latLng?.latitude,
        lng: location?.latLng?.longitude
    };

    if (!hasCoordinates(point)) {
        throw new Error("Invalid Google location.");
    }

    return point;
}

function googlePath(polyline) {
    const coordinates =
        polyline?.geoJsonLinestring?.coordinates;

    if (
        !Array.isArray(coordinates) ||
        coordinates.length < 2
    ) {
        throw new Error("Missing route geometry.");
    }

    const path = coordinates.map(point => ({
        lat: point?.[1],
        lng: point?.[0]
    }));

    if (!path.every(hasCoordinates)) {
        throw new Error("Invalid route geometry.");
    }

    return path;
}

function fail(res, status, code, error) {
    return res.status(status).json({
        code,
        error
    });
}

// ======================================================
// SAVED LOCATION LOOKUP
// ======================================================

// Build these once when the server starts.
const lookup = new Map();
const ids = new Set();

for (const node of nodes) {
    if (
        !normalise(node.id) ||
        !normalise(node.name) ||
        ids.has(normalise(node.id)) ||
        !hasCoordinates(destinationPoint(node)) ||
        (
            node.aliases !== undefined &&
            !Array.isArray(node.aliases)
        )
    ) {
        throw new Error(
            `Invalid or duplicate location: ${node.id}`
        );
    }

    ids.add(normalise(node.id));

    const names = [
        node.id,
        node.name,
        ...(node.aliases || [])
    ];

    for (const name of names) {
        const key = normalise(name);

        if (!key) continue;

        if (
            lookup.has(key) &&
            lookup.get(key) !== node
        ) {
            throw new Error(
                `Duplicate location alias: ${name}`
            );
        }

        lookup.set(key, node);
    }
}

const locations = nodes.map(node => {
    const point = hasCoordinates(node)
        ? node
        : destinationPoint(node);

    return {
        id: node.id,
        name: node.name,
        aliases: node.aliases || [],
        category: node.category || "building",
        lat: point.lat,
        lng: point.lng
    };
});

// ======================================================
// LOCATIONS ENDPOINT
// ======================================================

// Suggestions and Quick Access share this endpoint.
server.get("/locations", (req, res) => {
    res.json(locations);
});

// ======================================================
// WALKING ROUTE ENDPOINT
// ======================================================

server.get("/buildings", async (req, res) => {
    const {
        from,
        to,
        userLat,
        userLng
    } = req.query;

    if (!normalise(to)) {
        return fail(
            res,
            400,
            "INVALID_DESTINATION",
            "Please enter a destination."
        );
    }

    const endNode = lookup.get(normalise(to));

    if (!endNode) {
        return fail(
            res,
            404,
            "LOCATION_NOT_FOUND",
            "Location not found. Try WSS, SMH, FNB, CM or Matrix."
        );
    }

    // --------------------------------------------------
    // Starting position
    // --------------------------------------------------

    let origin;
    let startPoint;

    if (
        userLat !== undefined ||
        userLng !== undefined
    ) {
        if (
            typeof userLat !== "string" ||
            typeof userLng !== "string" ||
            !userLat.trim() ||
            !userLng.trim()
        ) {
            return fail(
                res,
                400,
                "INVALID_ORIGIN",
                "Both GPS latitude and longitude are required."
            );
        }

        startPoint = {
            lat: Number(userLat),
            lng: Number(userLng)
        };

        if (!hasCoordinates(startPoint)) {
            return fail(
                res,
                400,
                "INVALID_ORIGIN",
                "Your GPS coordinates are invalid."
            );
        }

        origin = coordinateWaypoint(startPoint);
    } else {
        const startNode = lookup.get(normalise(from));

        if (!startNode) {
            return fail(
                res,
                400,
                "INVALID_ORIGIN",
                "Provide your location or a recognised starting building."
            );
        }

        startPoint = destinationPoint(startNode);
        origin = nodeWaypoint(startNode);
    }

    if (!API_KEY) {
        return fail(
            res,
            503,
            "ROUTING_NOT_CONFIGURED",
            "The server is missing its Google Routes API key."
        );
    }

    // Stop upstream work if the browser disconnects.
    const controller = new AbortController();

    const cancel = () => {
        if (!res.writableEnded) {
            controller.abort();
        }
    };

    res.on("close", cancel);

    try {
        const response = await axios.post(
            "https://routes.googleapis.com/directions/v2:computeRoutes",

            {
                origin,
                destination: nodeWaypoint(endNode),
                travelMode: "WALK",
                languageCode: "en",
                units: "METRIC",
                polylineQuality: "HIGH_QUALITY",
                polylineEncoding: "GEO_JSON_LINESTRING"
            },

            {
                timeout: 12000,
                signal: controller.signal,

                headers: {
                    "Content-Type": "application/json",
                    "X-Goog-Api-Key": API_KEY,

                    "X-Goog-FieldMask": [
                        "routes.distanceMeters",
                        "routes.duration",
                        "routes.polyline.geoJsonLinestring",
                        "routes.legs.startLocation",
                        "routes.legs.endLocation",
                        "routes.legs.steps.distanceMeters",
                        "routes.legs.steps.endLocation",
                        "routes.legs.steps.polyline.geoJsonLinestring",
                        "routes.legs.steps.navigationInstruction",
                        "routes.warnings"
                    ].join(",")
                }
            }
        );

        if (controller.signal.aborted) return;

        const route = response.data.routes?.[0];

        if (!route) {
            return fail(
                res,
                404,
                "ROUTE_NOT_FOUND",
                "Google could not find a walking route."
            );
        }

        // --------------------------------------------------
        // Use Google's actual mapped geometry
        // --------------------------------------------------

        const pathCoordinates = googlePath(route.polyline);
        const legs = route.legs;

        if (!Array.isArray(legs) || !legs.length) {
            throw new Error("Missing route legs.");
        }

        const routeStart = googlePoint(
            legs[0].startLocation
        );

        const routeEnd = googlePoint(
            legs[legs.length - 1].endLocation
        );

        const target = destinationPoint(endNode);

        const endGap = distanceInMetres(
            routeEnd,
            target
        );

        const startGap = distanceInMetres(
            startPoint,
            routeStart
        );

        const warnings = [
            "Walking directions are in beta and may be missing sidewalks or pedestrian paths. Use caution and follow campus signs."
        ];

        if (Array.isArray(route.warnings)) {
            warnings.push(
                ...route.warnings.filter(
                    value => typeof value === "string"
                )
            );
        }

        // These limits flag large discrepancies.
        // They do NOT prove that an entrance is correct.
        if (
            verifiedEntrance(endNode) &&
            endGap > 25
        ) {
            return fail(
                res,
                422,
                "ENTRANCE_NOT_REACHED",
                `Google's walking path stops ${Math.round(endGap)} m from the verified entrance. A complete entrance route is unavailable.`
            );
        }

        if (startGap > 50) {
            return fail(
                res,
                422,
                "ORIGIN_NOT_CONNECTED",
                `Google's mapped path starts ${Math.round(startGap)} m from your position. Move to a mapped walkway and search again.`
            );
        }

        if (!verifiedEntrance(endNode)) {
            warnings.push(
                "The exact pedestrian entrance has not been verified. The route ends at Google's mapped access point."
            );
        }

        if (endGap > 25) {
            warnings.push(
                `The route endpoint is ${Math.round(endGap)} m from the saved venue pin. Check the venue signs.`
            );
        }

        if (startGap > 15) {
            warnings.push(
                `The mapped route starts about ${Math.round(startGap)} m from your supplied position.`
            );
        }

        // --------------------------------------------------
        // One instruction per walking step
        // --------------------------------------------------

        const navigationSteps = legs
            .flatMap(leg => leg.steps || [])
            .map(step => {
                const distance = step.distanceMeters ?? 0;

                if (
                    !Number.isFinite(distance) ||
                    distance < 0
                ) {
                    throw new Error(
                        "Invalid step distance."
                    );
                }

                return {
                    instruction:
                        step.navigationInstruction
                            ?.instructions?.trim() ||
                        "Follow the highlighted walking path.",

                    distanceMeters: Math.round(distance),

                    // A step finishes at its own endLocation.
                    target: googlePoint(step.endLocation),

                    // Used to detect missed turns.
                    pathCoordinates: googlePath(step.polyline),

                    isArrival: false
                };
            });

        if (!navigationSteps.length) {
            throw new Error("Missing walking steps.");
        }

        // This final step requires its own GPS check.
        // It does not claim that an unverified doorway was reached.
        navigationSteps.push({
            instruction:
                "Mapped walking route complete. Check the venue entrance signs.",

            distanceMeters: 0,
            target: routeEnd,
            pathCoordinates: [],
            isArrival: true
        });

        // --------------------------------------------------
        // Route totals
        // --------------------------------------------------

        const durationSeconds = Number(
            String(route.duration).replace(/s$/, "")
        );

        const distanceMeters = route.distanceMeters ?? 0;

        if (
            !Number.isFinite(durationSeconds) ||
            durationSeconds < 0 ||
            !Number.isFinite(distanceMeters) ||
            distanceMeters < 0
        ) {
            throw new Error("Invalid route totals.");
        }

        // Do not cache responses containing a user's route.
        res.set("Cache-Control", "no-store");

        return res.json({
            title: endNode.name,

            duration:
                `${Math.max(1, Math.ceil(durationSeconds / 60))} mins`,

            distance:
                `${Math.round(distanceMeters)} m`,

            directions: navigationSteps.map(
                step => step.instruction
            ),

            navigationSteps,
            pathCoordinates,
            warnings: [...new Set(warnings)],

            destination: {
                id: endNode.id,
                lat: target.lat,
                lng: target.lng,
                entranceVerified: verifiedEntrance(endNode)
            },

            // Useful when investigating a neighbouring-building route.
            googleRouteEnd: routeEnd,
            endpointGapMeters: Math.round(endGap),
            originGapMeters: Math.round(startGap),

            routingTarget: verifiedEntrance(endNode)
                ? "verified-entrance"
                : endNode.placeIdVerified === true &&
                  endNode.googlePlaceId
                    ? "verified-place"
                    : "saved-coordinate"
        });
    } catch (error) {
        if (controller.signal.aborted) return;

        const status = error.response?.status;

        // Do not log the Axios request object.
        // Its headers contain the secret API key.
        console.error(
            "Google Routes failed:",
            status || error.code || "INVALID_RESPONSE"
        );

        if ([401, 403].includes(status)) {
            return fail(
                res,
                503,
                "ROUTING_CONFIGURATION_ERROR",
                "Check the server API key, enabled Routes API and billing."
            );
        }

        if (status === 429) {
            return fail(
                res,
                503,
                "ROUTING_LIMIT_REACHED",
                "Navigation is busy. Please try again shortly."
            );
        }

        if (
            ["ECONNABORTED", "ETIMEDOUT"].includes(error.code)
        ) {
            return fail(
                res,
                504,
                "ROUTING_TIMEOUT",
                "Walking directions took too long. Please try again."
            );
        }

        return fail(
            res,
            502,
            "ROUTING_FAILED",
            "Walking directions could not be loaded. Please try again."
        );
    } finally {
        res.off("close", cancel);
    }
});

// Start after validating the saved venue data.
server.listen(PORT, "0.0.0.0", () => {
    console.log(`The server is running on port ${PORT}`);
});