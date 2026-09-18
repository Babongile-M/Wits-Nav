require("dotenv").config();

const fs = require("fs");
const axios = require("axios");

const nodes = require("./nodes.json");

const API_KEY = (
    process.env.GOOGLE_ROUTE_API ||
    process.env.GOOGLE_ROUTES_API_KEY ||
    ""
).trim();

if (!API_KEY) {
    console.error(
        "Missing GOOGLE_ROUTE_API environment variable."
    );

    process.exit(1);
}


// -----------------------------------------------------
// WITS CAMPUS SEARCH AREA
// -----------------------------------------------------

// Keeps Google Places search around the
// Braamfontein Wits campus area.
const WITS_BOUNDS = {
    low: {
        latitude: -26.198,
        longitude: 28.017
    },

    high: {
        latitude: -26.183,
        longitude: 28.036
    }
};


// -----------------------------------------------------
// HELPERS
// -----------------------------------------------------

function hasCoordinates(location) {
    return Boolean(
        location &&
        Number.isFinite(location.lat) &&
        Number.isFinite(location.lng) &&
        Math.abs(location.lat) <= 90 &&
        Math.abs(location.lng) <= 180
    );
}


function normalise(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}


function distanceInMetres(a, b) {
    const toRadians =
        value =>
            value * Math.PI / 180;

    const earthRadius =
        6371000;

    const dLat =
        toRadians(
            b.lat - a.lat
        );

    const dLng =
        toRadians(
            b.lng - a.lng
        );

    const h =
        Math.sin(dLat / 2) ** 2 +

        Math.cos(
            toRadians(a.lat)
        ) *

        Math.cos(
            toRadians(b.lat)
        ) *

        Math.sin(dLng / 2) ** 2;

    return (
        2 *
        earthRadius *
        Math.asin(
            Math.sqrt(
                Math.min(
                    1,
                    Math.max(0, h)
                )
            )
        )
    );
}


// -----------------------------------------------------
// FIND THE GOOGLE PLACE
// -----------------------------------------------------

async function findGooglePlace(node) {

    const query =
        `${node.name}, ` +
        `University of the Witwatersrand, Johannesburg`;


    const response =
        await axios.post(
            "https://places.googleapis.com/v1/places:searchText",

            {
                textQuery:
                    query,

                pageSize:
                    5,

                locationRestriction: {
                    rectangle:
                        WITS_BOUNDS
                }
            },

            {
                timeout:
                    12000,

                headers: {
                    "Content-Type":
                        "application/json",

                    "X-Goog-Api-Key":
                        API_KEY,

                    "X-Goog-FieldMask":
                        [
                            "places.id",
                            "places.displayName",
                            "places.formattedAddress",
                            "places.location"
                        ].join(",")
                }
            }
        );


    const places =
        response.data.places ||
        [];


    if (!places.length) {
        return null;
    }


    const targetName =
        normalise(
            node.name
        );


    // Score the results so we do not blindly
    // accept Google's first result.
    const ranked =
        places.map(
            place => {

                const googleName =
                    normalise(
                        place.displayName
                            ?.text
                    );


                let nameScore =
                    0;


                if (
                    googleName ===
                    targetName
                ) {
                    nameScore =
                        100;
                }

                else if (
                    googleName.includes(
                        targetName
                    ) ||

                    targetName.includes(
                        googleName
                    )
                ) {
                    nameScore =
                        70;
                }


                let distance =
                    Infinity;


                if (
                    hasCoordinates(
                        node
                    ) &&

                    Number.isFinite(
                        place.location
                            ?.latitude
                    ) &&

                    Number.isFinite(
                        place.location
                            ?.longitude
                    )
                ) {

                    distance =
                        distanceInMetres(
                            {
                                lat:
                                    node.lat,

                                lng:
                                    node.lng
                            },

                            {
                                lat:
                                    place.location
                                        .latitude,

                                lng:
                                    place.location
                                        .longitude
                            }
                        );
                }


                return {
                    place,
                    nameScore,
                    distance
                };
            }
        );


    ranked.sort(
        (a, b) => {

            if (
                b.nameScore !==
                a.nameScore
            ) {
                return (
                    b.nameScore -
                    a.nameScore
                );
            }


            return (
                a.distance -
                b.distance
            );
        }
    );


    return (
        ranked[0]?.place ||
        null
    );
}


// -----------------------------------------------------
// GET GOOGLE BUILDING ENTRANCES
// -----------------------------------------------------

async function getEntrances(placeId) {

    const response =
        await axios.post(
            "https://geocode.googleapis.com/v4/geocode/destinations",

            {
                place:
                    `places/${placeId}`,

                travelModes: [
                    "WALK"
                ],

                languageCode:
                    "en",

                regionCode:
                    "ZA"
            },

            {
                timeout:
                    12000,

                headers: {
                    "Content-Type":
                        "application/json",

                    "X-Goog-Api-Key":
                        API_KEY,

                    "X-Goog-FieldMask":
                        [
                            "destinations.entrances",
                            "destinations.primary.place"
                        ].join(",")
                }
            }
        );


    const destinations =
        response.data.destinations ||
        [];


    if (!destinations.length) {
        return [];
    }


    return (
        destinations[0]
            .entrances ||
        []
    );
}


// -----------------------------------------------------
// CHOOSE MAIN ENTRANCE
// -----------------------------------------------------

function chooseEntrance(entrances) {

    if (
        !Array.isArray(
            entrances
        ) ||

        entrances.length ===
            0
    ) {
        return null;
    }


    // Google's preferred entrance should be
    // our first choice.
    const preferred =
        entrances.find(
            entrance =>
                Array.isArray(
                    entrance.tags
                ) &&

                entrance.tags.includes(
                    "PREFERRED"
                )
        );


    const selected =
        preferred ||
        entrances[0];


    const latitude =
        selected.location
            ?.latitude;

    const longitude =
        selected.location
            ?.longitude;


    if (
        !Number.isFinite(
            latitude
        ) ||

        !Number.isFinite(
            longitude
        )
    ) {
        return null;
    }


    return {
        lat:
            latitude,

        lng:
            longitude,

        source:
            preferred
                ? "google-preferred"
                : "google-entrance"
    };
}


// -----------------------------------------------------
// BUILD THE NEW NODE LIST
// -----------------------------------------------------

async function generate() {

    const updatedNodes =
        [];


    for (
        const node of nodes
    ) {

        console.log(
            `\nChecking: ${node.name}`
        );


        // Campus gates are already entrances.
        // Do not ask Google to find a building
        // doorway for them.
        if (
            node.category ===
            "entrance"
        ) {

            updatedNodes.push({
                ...node,

                entrance: {
                    lat:
                        node.lat,

                    lng:
                        node.lng
                },

                entranceSource:
                    "manual-gate"
            });


            console.log(
                "  ✓ Campus gate kept as supplied."
            );

            continue;
        }


        // "Bridge" is not really a building.
        if (
            normalise(node.id) ===
            "bridge"
        ) {

            updatedNodes.push({
                ...node,

                entrance: {
                    lat:
                        node.lat,

                    lng:
                        node.lng
                },

                entranceSource:
                    "manual-location"
            });


            console.log(
                "  ✓ Bridge kept as supplied."
            );

            continue;
        }


        try {

            // ---------------------------------
            // 1. Find building Place ID
            // ---------------------------------

            const place =
                await findGooglePlace(
                    node
                );


            if (!place) {

                console.warn(
                    "  ⚠ Google place not found."
                );


                updatedNodes.push({
                    ...node,

                    entrance: {
                        lat:
                            node.lat,

                        lng:
                            node.lng
                    },

                    entranceSource:
                        "fallback-original"
                });


                continue;
            }


            console.log(
                `  Google place: ${
                    place.displayName
                        ?.text ||
                    place.id
                }`
            );


            // ---------------------------------
            // 2. Get actual entrances
            // ---------------------------------

            const entrances =
                await getEntrances(
                    place.id
                );


            console.log(
                `  Entrances returned: ${entrances.length}`
            );


            // ---------------------------------
            // 3. Pick preferred entrance
            // ---------------------------------

            const entrance =
                chooseEntrance(
                    entrances
                );


            if (!entrance) {

                console.warn(
                    "  ⚠ No entrance data from Google."
                );


                updatedNodes.push({
                    ...node,

                    googlePlaceId:
                        place.id,

                    entrance: {
                        lat:
                            node.lat,

                        lng:
                            node.lng
                    },

                    entranceSource:
                        "fallback-original"
                });


                continue;
            }


            console.log(
                `  ✓ Entrance: ` +
                `${entrance.lat}, ` +
                `${entrance.lng} ` +
                `(${entrance.source})`
            );


            updatedNodes.push({
                ...node,

                // Google's resolved building
                // location is useful for debugging.
                googlePlaceId:
                    place.id,

                entrance: {
                    lat:
                        entrance.lat,

                    lng:
                        entrance.lng
                },

                entranceSource:
                    entrance.source
            });


            // Small delay so we don't hammer
            // Google's APIs.
            await new Promise(
                resolve =>
                    setTimeout(
                        resolve,
                        150
                    )
            );
        }

        catch (error) {

            console.error(
                "  ✗ Failed:",
                error.response
                    ?.data
                    ?.error
                    ?.message ||

                error.message
            );


            // Never destroy the original location.
            updatedNodes.push({
                ...node,

                entrance: {
                    lat:
                        node.lat,

                    lng:
                        node.lng
                },

                entranceSource:
                    "fallback-original"
            });
        }
    }


    // -------------------------------------------------
    // WRITE RESULT
    // -------------------------------------------------

    fs.writeFileSync(
        "./nodes.generated.json",

        JSON.stringify(
            updatedNodes,
            null,
            2
        ),

        "utf8"
    );


    console.log(
        "\n================================="
    );

    console.log(
        "Finished."
    );

    console.log(
        "Created: nodes.generated.json"
    );

    console.log(
        "=================================\n"
    );
}


generate().catch(
    error => {

        console.error(
            error
        );

        process.exit(1);
    }
);