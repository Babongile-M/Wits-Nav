require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");

const nodes = require("./nodes.json");

const server = express();
const PORT = process.env.PORT || 8080;

server.use(cors());

// Make searches ignore capital letters and extra spaces.
function normalise(value) {
    return typeof value === "string"
        ? value.trim().toLowerCase().replace(/\s+/g, " ")
        : "";
}

// Check latitude and longitude.
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

// Build the searchable location lookup.
const locationLookup = new Map();

for (const node of nodes) {
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
            throw new Error(`Duplicate location alias: ${name}`);
        }

        locationLookup.set(key, node);
    }
}

function findLocation(value) {
    return locationLookup.get(normalise(value)) || null;
}

// Convert our coordinates into Google's waypoint format.
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

// Convert a Google step endpoint into our frontend format.
function stepTarget(step) {
    const point = step.endLocation?.latLng;

    const target = {
        lat: point?.latitude,
        lng: point?.longitude
    };

    if (!hasCoordinates(target)) {
        throw new Error("Google returned an invalid step endpoint.");
    }

    return target;
}

// Return searchable locations and category marker coordinates.
server.get("/locations", (req, res) => {
    const locations = nodes
        .filter(hasCoordinates)
        .map(node => ({
            id: node.id,
            name: node.name,
            aliases: node.aliases || [],
            category: node.category || "building",
            lat: node.lat,
            lng: node.lng
        }));

    res.json(locations);
});

// Calculate a walking route.
server.get("/buildings", async (req, res) => {
    const { from, to, userLat, userLng } = req.query;

    if (!normalise(to)) {
        return res.status(400).json({
            error: "Please enter a destination."
        });
    }

    const endLocation = findLocation(to);

    if (!endLocation) {
        return res.status(404).json({
            code: "LOCATION_NOT_FOUND",
            error: "Destination not found. Try WSS, SMH, FNB, CM or Matrix."
        });
    }

    if (!hasCoordinates(endLocation)) {
        return res.status(400).json({
            error: `${endLocation.name} is listed, but its coordinates have not been added yet.`
        });
    }

    let startLocation;

    // If either GPS coordinate is supplied, require both.
    if (userLat !== undefined || userLng !== undefined) {
        const validInput =
            typeof userLat === "string" &&
            typeof userLng === "string" &&
            userLat.trim() !== "" &&
            userLng.trim() !== "";

        if (!validInput) {
            return res.status(400).json({
                error: "Both GPS latitude and longitude are required."
            });
        }

        startLocation = {
            lat: Number(userLat),
            lng: Number(userLng)
        };

        if (!hasCoordinates(startLocation)) {
            return res.status(400).json({
                error: "Your GPS coordinates are invalid. Please try again."
            });
        }
    } else {
        // Alternatively, start from a saved venue.
        startLocation = findLocation(from);

        if (!startLocation) {
            return res.status(400).json({
                error: "Provide your live location or a recognised starting building."
            });
        }

        if (!hasCoordinates(startLocation)) {
            return res.status(400).json({
                error: `${startLocation.name} does not have coordinates yet.`
            });
        }
    }

    // Your Railway variable is GOOGLE_ROUTE_API.
    // The second name is only a fallback in case you rename it later.
    const apiKey = (
        process.env.GOOGLE_ROUTE_API ||
        process.env.GOOGLE_ROUTES_API_KEY ||
        ""
    ).trim();

    if (!apiKey) {
        return res.status(503).json({
            code: "ROUTING_NOT_CONFIGURED",
            error: "Walking navigation is not configured yet."
        });
    }

    try {
        const googleResponse = await axios.post(
            "https://routes.googleapis.com/directions/v2:computeRoutes",
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
                    "X-Goog-Api-Key": apiKey,
                    "X-Goog-FieldMask": [
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

        const route = googleResponse.data.routes?.[0];

        if (!route) {
            return res.status(404).json({
                code: "ROUTE_NOT_FOUND",
                error: "No walking route was found between these locations."
            });
        }

        // Google GeoJSON uses [longitude, latitude].
        const coordinates =
            route.polyline?.geoJsonLinestring?.coordinates;

        if (
            !Array.isArray(coordinates) ||
            coordinates.length < 2 ||
            !coordinates.every(point =>
                Array.isArray(point) && point.length >= 2
            )
        ) {
            throw new Error(
                "Google returned incomplete route geometry."
            );
        }

        const pathCoordinates = coordinates.map(point => ({
            lat: point[1],
            lng: point[0]
        }));

        if (!pathCoordinates.every(hasCoordinates)) {
            throw new Error(
                "Google returned invalid route coordinates."
            );
        }

        const rawSteps = (route.legs || [])
            .flatMap(leg => leg.steps || []);

        // Every Google step returned for this route belongs
        // to the walking route.
        const walkingSteps = rawSteps;

        if (walkingSteps.length === 0) {
            throw new Error(
                "Google returned no walking instructions."
            );
        }

        const navigationSteps = walkingSteps.map(step => {
            const distance = step.distanceMeters ?? 0;

            if (
                !Number.isFinite(distance) ||
                distance < 0
            ) {
                throw new Error(
                    "Google returned an invalid step distance."
                );
            }

            const instruction =
                step.navigationInstruction
                    ?.instructions
                    ?.trim();

            return {
                instruction:
                    instruction ||
                    `Follow the highlighted path for about ${Math.round(distance)} metres.`,

                distanceMeters: Math.round(distance),

                // User advances to next instruction after
                // reaching the END of this step.
                target: stepTarget(step),

                isArrival: false
            };
        });

        // Add our own final arrival instruction.
        const lastWalkingStep =
            navigationSteps[
                navigationSteps.length - 1
            ];

        navigationSteps.push({
            instruction:
                "You have reached the end of the mapped walking route.",

            distanceMeters: 0,

            target: {
                ...lastWalkingStep.target
            },

            isArrival: true
        });

        // Google duration looks like "245s".
        const durationSeconds =
            Number.parseFloat(route.duration);

        const distanceMeters =
            route.distanceMeters ?? 0;

        if (
            !Number.isFinite(durationSeconds) ||
            durationSeconds < 0 ||
            !Number.isFinite(distanceMeters) ||
            distanceMeters < 0
        ) {
            throw new Error(
                "Google returned invalid route totals."
            );
        }

        const walkingNotice =
            "Walking directions are in beta and may be missing sidewalks " +
            "or pedestrian paths. Use caution and follow campus signs.";

        const warnings = [
            walkingNotice,
            ...(Array.isArray(route.warnings)
                ? route.warnings
                : [])
        ].filter(value =>
            typeof value === "string" &&
            value.trim() !== ""
        );

        return res.json({
            title:
                endLocation.name ||
                to.trim(),

            duration:
                `${Math.max(
                    1,
                    Math.ceil(durationSeconds / 60)
                )} mins`,

            distance:
                `${Math.round(distanceMeters)} m`,

            // Compatibility with existing interface.
            directions:
                navigationSteps.map(
                    step => step.instruction
                ),

            // Used by GPS step tracker.
            navigationSteps,

            // Used to draw the yellow Google Maps route.
            pathCoordinates,

            warnings: [
                ...new Set(warnings)
            ]
        });

    } catch (error) {
        const upstreamStatus =
            error.response?.status;

        const googleError =
            error.response?.data?.error;

        // Do not print the complete Axios error because
        // it may contain request headers.
        console.error(
            "Google Routes request failed:",
            {
                httpStatus: upstreamStatus,
                code:
                    googleError?.status ||
                    error.code ||
                    "INVALID_RESPONSE"
            }
        );

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
                code:
                    "ROUTING_CONFIGURATION_ERROR",

                error:
                    "Walking navigation is unavailable because of a server configuration problem."
            });
        }

        if (upstreamStatus === 429) {
            return res.status(503).json({
                code:
                    "ROUTING_LIMIT_REACHED",

                error:
                    "Walking navigation is temporarily unavailable. Please try again later."
            });
        }

        // Helpful server-side logging without exposing API key.
        if (googleError?.message) {
            console.error(
                "Google Routes message:",
                googleError.message
            );
        }

        return res.status(502).json({
            code: "ROUTING_FAILED",
            error:
                "Walking directions could not be loaded. Please try again."
        });
    }
});

server.listen(
    PORT,
    "0.0.0.0",
    () => {
        console.log(
            `The server is running on port ${PORT}`
        );
    }
);