// RUNNING ON THE LIVE RAILWAY BACKEND
const SERVER_URL =
    "https://wits-nav-production.up.railway.app";

const WITS_CENTRE = {
    lat: -26.1906,
    lng: 28.0286
};

window.lucide?.createIcons();

// ======================================================
// SHARED ELEMENT AND COORDINATE HELPERS
// ======================================================

// Cache element handles instead of repeatedly searching the document.
const elements = new Map();

function el(id) {
    if (!elements.has(id)) {
        elements.set(id, document.getElementById(id));
    }

    return elements.get(id);
}

function text(id, value) {
    if (el(id)) el(id).textContent = value;
}

function hide(id, hidden) {
    el(id)?.classList.toggle("hidden", hidden);
}

function normalise(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");
}

function validPoint(point) {
    return Boolean(
        point &&
        Number.isFinite(point.lat) &&
        Number.isFinite(point.lng) &&
        Math.abs(point.lat) <= 90 &&
        Math.abs(point.lng) <= 180
    );
}

function distance(a, b) {
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

// ======================================================
// APP STATE
// ======================================================

let map;
let userMarker;
let routeLine;
let infoWindow;

let watchId = null;
let latestFix = null;
let markers = [];

let route = null;
let destination = null;
let category = null;
let routeController = null;

// Changes whenever a search/category/clear action replaces another.
let viewVersion = 0;

let stepIndex = 0;
let finished = false;
let nearSince = null;
let offReadings = 0;
let lastNavigationTime = 0;
let lastRouteTime = 0;
let centredOnUser = false;
let activeTab = "home";

// Starting values for campus testing.
// These settings cannot guarantee doorway-level GPS accuracy.
const MAX_FIX_AGE = 10000;
const MAX_GPS_ERROR = 20;
const STEP_RADIUS = 12;
const ARRIVAL_RADIUS = 15;
const REROUTE_COOLDOWN = 30000;

function goodFix(fix = latestFix) {
    return Boolean(
        fix &&
        validPoint(fix) &&
        Number.isFinite(fix.time) &&
        Date.now() - fix.time <= MAX_FIX_AGE &&
        fix.time <= Date.now() + 1000 &&
        Number.isFinite(fix.accuracy) &&
        fix.accuracy >= 0 &&
        fix.accuracy <= MAX_GPS_ERROR
    );
}

// ======================================================
// EXISTING CARDS AND MAP RESET
// ======================================================

function card(
    message,
    heading = "Search message",
    navigation = false
) {
    hide("navigation-steps-panel", false);
    hide("navigation-card-icon", !navigation);
    hide("search-card-icon", navigation);

    text(
        "instructions-panel-heading",
        navigation ? "Route Progress" : "Search result"
    );

    text("instructions-card-heading", heading);

    const paragraph = el("step-instruction-text");

    if (paragraph) {
        paragraph.style.whiteSpace = "pre-line";
    }

    text("step-instruction-text", message);
}

function resetStats(
    title = "No destination selected",
    detail = "Search or choose Quick Access"
) {
    text("destination-title", title);
    text("map-destination-title", title);
    text("destination-category", detail);
    text("map-destination-meta", "");

    for (const id of [
        "walk-time",
        "walk-distance",
        "eta-text",
        "map-distance-pill"
    ]) {
        text(id, "—");
    }

    text("route-label", "No active route");
}

function clearMap() {
    // Invalidate pending responses before changing the map.
    viewVersion++;

    routeController?.abort();
    routeController = null;

    routeLine?.setMap(null);
    routeLine = null;

    markers.forEach(marker => marker.setMap(null));
    markers = [];

    infoWindow?.close();

    route = null;
    destination = null;
    category = null;

    stepIndex = 0;
    finished = false;
    nearSince = null;
    offReadings = 0;
    lastNavigationTime = 0;

    hide("navigation-steps-panel", true);
    resetStats();
}

// ======================================================
// GOOGLE MAP AND LIVE GPS
// ======================================================

window.initMap = function initMap() {
    if (map) return;

    const container = el("google-campus-map");

    // Keep your existing floating badges outside Google's
    // internally managed map container.
    Array.from(container.children).forEach(child => {
        container.parentElement.appendChild(child);
    });

    map = new google.maps.Map(container, {
        zoom: 16,
        center: WITS_CENTRE,
        gestureHandling: "greedy",
        disableDefaultUI: true,
        clickableIcons: false
    });

    infoWindow = new google.maps.InfoWindow();

    startGPS();
};

function startGPS() {
    if (!navigator.geolocation) {
        text("gps-text", "GPS unavailable");
        return;
    }

    // Prevent duplicate GPS watchers.
    if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
    }

    watchId = navigator.geolocation.watchPosition(
        position => {
            const fix = {
                lat: position.coords.latitude,
                lng: position.coords.longitude,
                accuracy: position.coords.accuracy,
                time: position.timestamp
            };

            if (
                !validPoint(fix) ||
                !Number.isFinite(fix.time) ||
                (
                    latestFix &&
                    fix.time <= latestFix.time
                )
            ) {
                return;
            }

            latestFix = fix;

            text(
                "gps-text",
                goodFix() ? "GPS Active" : "GPS uncertain"
            );

            if (!userMarker) {
                userMarker = new google.maps.Marker({
                    map,
                    title: "Your Location",

                    icon: {
                        path: google.maps.SymbolPath.CIRCLE,
                        scale: 8,
                        fillColor: "#4285F4",
                        fillOpacity: 1,
                        strokeColor: "#FFFFFF",
                        strokeWeight: 2
                    }
                });
            }

            userMarker.setPosition({
                lat: fix.lat,
                lng: fix.lng
            });

            // Centre once so GPS updates do not fight
            // the user's attempts to explore the map.
            if (
                !centredOnUser &&
                goodFix() &&
                !destination &&
                !category &&
                activeTab === "home"
            ) {
                map.setCenter(fix);
                centredOnUser = true;
            }

            updateNavigation(fix);
        },

        () => {
            latestFix = null;
            nearSince = null;

            text("gps-text", "GPS unavailable");

            if (route) {
                showStep(
                    "Location unavailable. Navigation is paused until GPS returns."
                );
            }
        },

        {
            enableHighAccuracy: true,
            maximumAge: 0,
            timeout: 10000
        }
    );
}

// ======================================================
// SHARED LOCATION LIST
// ======================================================

let locations = null;
let locationsPromise = null;

async function loadLocations() {
    if (locations) return locations;
    if (locationsPromise) return locationsPromise;

    // Suggestions and Quick Access share one request.
    locationsPromise = (async () => {
        const controller = new AbortController();

        const timer = setTimeout(
            () => controller.abort(),
            10000
        );

        try {
            const response = await fetch(
                `${SERVER_URL}/locations`,
                {
                    signal: controller.signal
                }
            );

            if (!response.ok) {
                throw new Error(
                    "Locations could not be loaded."
                );
            }

            const data = await response.json();

            if (!Array.isArray(data)) {
                throw new Error("Invalid location list.");
            }

            locations = data
                .filter(point =>
                    validPoint(point) &&
                    typeof point.name === "string"
                )
                .map(point => {
                    const aliases = Array.isArray(point.aliases)
                        ? point.aliases
                        : [];

                    return {
                        ...point,
                        aliases,

                        // Normalise once instead of on every keystroke.
                        searchNames: [
                            point.id,
                            point.name,
                            ...aliases
                        ].map(normalise)
                    };
                });

            return locations;
        } finally {
            clearTimeout(timer);
        }
    })();

    try {
        return await locationsPromise;
    } finally {
        // A failed request can be retried by Quick Access.
        locationsPromise = null;
    }
}

function updateSuggestions() {
    const list = el("location-suggestions");
    list.replaceChildren();

    const query = normalise(
        el("search-input").value
    );

    if (
        !query ||
        !locations ||
        locations.some(
            point => normalise(point.name) === query
        )
    ) {
        return;
    }

    const matches = locations
        .map(point => ({
            point,

            score: Math.max(
                ...point.searchNames.map(name =>
                    name === query
                        ? 3
                        : name.startsWith(query)
                            ? 2
                            : name.includes(query)
                                ? 1
                                : 0
                )
            )
        }))
        .filter(item => item.score)
        .sort((a, b) =>
            b.score - a.score ||
            a.point.name.localeCompare(b.point.name)
        )
        .slice(0, 8);

    for (const { point } of matches) {
        const option = document.createElement("option");

        option.value = point.name;
        option.label = [
            point.id,
            ...point.aliases
        ].join(" • ");

        list.appendChild(option);
    }
}

// ======================================================
// ROUTE SEARCH
// ======================================================

async function searchDestination(value) {
    const query = String(value || "").trim();

    if (!query) return;

    clearMap();

    el("search-input").blur();
    el("location-suggestions").replaceChildren();

    if (!map) {
        card(
            "The map is still loading. Please try again."
        );
        return;
    }

    if (!goodFix()) {
        card(
            "Enable location access and wait for a fresh, accurate GPS reading. Then search again.",
            "Waiting for GPS"
        );
        return;
    }

    destination = query;

    await fetchRoute(query);
}

async function fetchRoute(query, rerouting = false) {
    const version = viewVersion;
    const fix = latestFix;

    if (!goodFix(fix)) return;

    routeController?.abort();

    const controller = new AbortController();
    routeController = controller;

    const timer = setTimeout(
        () => controller.abort(),
        15000
    );

    lastRouteTime = Date.now();

    card(
        rerouting
            ? "Updating the route from your current position..."
            : "Calculating walking directions...",
        "Loading route"
    );

    text("route-label", "Calculating...");

    try {
        const params = new URLSearchParams({
            to: query,
            userLat: fix.lat,
            userLng: fix.lng
        });

        const response = await fetch(
            `${SERVER_URL}/buildings?${params}`,
            {
                signal: controller.signal
            }
        );

        const data = await response.json();

        // A previous search must never overwrite a newer one.
        if (
            version !== viewVersion ||
            routeController !== controller
        ) {
            return;
        }

        if (!response.ok) {
            throw new Error(
                data.error ||
                "Walking directions could not be loaded."
            );
        }

        const validRoute =
            Array.isArray(data.pathCoordinates) &&
            data.pathCoordinates.length >= 2 &&
            data.pathCoordinates.every(validPoint) &&
            validPoint(data.destination) &&
            Array.isArray(data.navigationSteps) &&
            data.navigationSteps.length > 0 &&
            data.navigationSteps.every(step =>
                validPoint(step.target) &&
                typeof step.instruction === "string" &&
                Array.isArray(step.pathCoordinates) &&
                step.pathCoordinates.every(validPoint)
            );

        if (!validRoute) {
            throw new Error(
                "The server returned incomplete navigation data. Deploy the updated server."
            );
        }

        route = data;
        stepIndex = 0;
        finished = false;
        nearSince = null;
        offReadings = 0;
        lastNavigationTime = 0;

        resetStats(
            data.title,
            "Walking route to mapped access point"
        );

        text("walk-time", data.duration);
        text("eta-text", data.duration);
        text("walk-distance", data.distance);
        text("map-distance-pill", data.distance);
        text("route-label", "Walking route");

        routeLine?.setMap(null);

        routeLine = new google.maps.Polyline({
            map,
            path: data.pathCoordinates,
            strokeColor: "#ffb81c",
            strokeOpacity: 0.9,
            strokeWeight: 5
        });

        // Avoid repeatedly zooming out during rerouting.
        if (!rerouting) {
            const bounds = new google.maps.LatLngBounds();

            data.pathCoordinates.forEach(point => {
                bounds.extend(point);
            });

            map.fitBounds(bounds, 60);
        }

        showStep();
    } catch (error) {
        if (
            version !== viewVersion ||
            routeController !== controller
        ) {
            return;
        }

        const timedOut = controller.signal.aborted;

        clearMap();

        card(
            timedOut
                ? "The request took too long. Please search again."
                : error.message,
            "Route unavailable"
        );
    } finally {
        clearTimeout(timer);

        if (routeController === controller) {
            routeController = null;
        }
    }
}

// ======================================================
// ONE-STEP-AT-A-TIME NAVIGATION
// ======================================================

function showStep(note = "") {
    if (!route) return;

    const step = route.navigationSteps[stepIndex];

    const instruction =
        step.isArrival && !finished
            ? "Approaching the end of the mapped route."
            : step.instruction;

    // Keep Google notices in the existing instructions card.
    const notices = Array.isArray(route.warnings)
        ? route.warnings.filter(
            warning => typeof warning === "string"
        )
        : [];

    card(
        [
            instruction,
            note,
            ...notices
        ].filter(Boolean).join("\n\n"),

        finished
            ? "Route complete"
            : `Step ${stepIndex + 1} of ${route.navigationSteps.length}`,

        true
    );
}

// Distance to a mapped step.
// Used for missed-turn detection, not to invent walking paths.
function distanceToPath(point, path) {
    if (!path?.length) return Infinity;

    if (path.length === 1) {
        return distance(point, path[0]);
    }

    const scale = Math.PI * 6371000 / 180;
    const xScale = scale * Math.cos(point.lat * Math.PI / 180);

    let nearest = Infinity;

    for (let i = 1; i < path.length; i++) {
        const ax = (path[i - 1].lng - point.lng) * xScale;
        const ay = (path[i - 1].lat - point.lat) * scale;

        const bx = (path[i].lng - point.lng) * xScale;
        const by = (path[i].lat - point.lat) * scale;

        const dx = bx - ax;
        const dy = by - ay;
        const length = dx * dx + dy * dy;

        const t = length
            ? Math.max(
                0,
                Math.min(
                    1,
                    -(ax * dx + ay * dy) / length
                )
            )
            : 0;

        nearest = Math.min(
            nearest,
            Math.hypot(
                ax + t * dx,
                ay + t * dy
            )
        );
    }

    return nearest;
}

function updateNavigation(fix) {
    if (
        !route ||
        finished ||
        routeController
    ) {
        return;
    }

    if (!goodFix(fix)) {
        nearSince = null;
        offReadings = 0;

        showStep(
            "GPS is uncertain. Waiting for a clearer reading."
        );

        return;
    }

    // Process at most one navigation reading per second.
    if (fix.time - lastNavigationTime < 1000) return;

    lastNavigationTime = fix.time;

    const step = route.navigationSteps[stepIndex];

    // Be stricter at the final endpoint.
    // Reported GPS uncertainty is included in the proximity test.
    const near = step.isArrival
        ? fix.accuracy <= 10 &&
          distance(fix, step.target) + fix.accuracy <= ARRIVAL_RADIUS
        : distance(fix, step.target) <= STEP_RADIUS;

    if (near) {
        offReadings = 0;

        if (nearSince === null) {
            nearSince = fix.time;
        }

        // Require separate nearby readings spanning at least two seconds.
        if (fix.time - nearSince < 2000) {
            showStep();
            return;
        }

        nearSince = null;

        // Check the CURRENT final step, not just whether
        // advancing the index selected an arrival step.
        if (step.isArrival) {
            finished = true;

            const checkedEntrance =
                route.destination.entranceVerified === true &&
                distance(fix, route.destination) + fix.accuracy <=
                    ARRIVAL_RADIUS;

            showStep(
                checkedEntrance
                    ? "You are near the verified entrance. Confirm the building signage."
                    : "This confirms the mapped route endpoint, not the exact building entrance."
            );
        } else {
            stepIndex = Math.min(
                stepIndex + 1,
                route.navigationSteps.length - 1
            );

            showStep();
        }

        return;
    }

    nearSince = null;

    const deviation = step.isArrival
        ? distance(fix, step.target)
        : distanceToPath(
            fix,
            step.pathCoordinates
        );

    offReadings =
        deviation > Math.max(30, fix.accuracy * 2)
            ? offReadings + 1
            : 0;

    if (
        offReadings >= 3 &&
        Date.now() - lastRouteTime >= REROUTE_COOLDOWN
    ) {
        offReadings = 0;

        void fetchRoute(destination, true);
    } else {
        showStep(
            step.isArrival
                ? "Waiting for a precise GPS reading at the mapped endpoint."
                : ""
        );
    }
}

// ======================================================
// QUICK ACCESS MARKERS
// ======================================================

async function showCategory(selected, title) {
    clearMap();

    if (!map) {
        card(
            "The map is still loading. Please try again."
        );
        return;
    }

    category = selected;

    const version = viewVersion;

    el("search-input").value = "";
    el("search-input").blur();
    el("location-suggestions").replaceChildren();

    resetStats(title, "Saved campus locations");
    text("route-label", title);

    card(
        `Loading ${title.toLowerCase()}...`,
        "Map locations"
    );

    try {
        const saved = await loadLocations();

        if (version !== viewVersion) return;

        const matches = saved.filter(
            point => point.category === selected
        );

        const bounds = new google.maps.LatLngBounds();

        for (const point of matches) {
            const position = {
                lat: point.lat,
                lng: point.lng
            };

            const marker = new google.maps.Marker({
                map,
                position,
                title: point.name,

                label: {
                    text: point.name,
                    color: "#002855",
                    fontSize: "12px",
                    fontWeight: "700",
                    className: "venue-marker-label"
                },

                icon: {
                    path: google.maps.SymbolPath.CIRCLE,
                    scale: 8,

                    fillColor: selected === "residence"
                        ? "#ffb81c"
                        : "#059669",

                    fillOpacity: 1,
                    strokeColor: "#ffffff",
                    strokeWeight: 2,
                    labelOrigin: new google.maps.Point(0, 3)
                }
            });

            // Selecting a marker only shows its name.
            marker.addListener("click", () => {
                const content = document.createElement("div");

                content.textContent = point.name;
                content.style.fontWeight = "700";
                content.style.color = "#002855";

                infoWindow.setContent(content);

                infoWindow.open({
                    map,
                    anchor: marker
                });
            });

            markers.push(marker);
            bounds.extend(position);
        }

        if (matches.length === 1) {
            map.setCenter(matches[0]);
            map.setZoom(17);
        } else if (matches.length) {
            map.fitBounds(bounds, 80);
        }

        text(
            "destination-category",
            `${matches.length} saved locations`
        );

        card(
            matches.length
                ? `Showing ${matches.length} ${title.toLowerCase()}. Tap a marker to see its name.`
                : `No ${title.toLowerCase()} have been saved yet.`,
            "Map locations"
        );
    } catch {
        if (version === viewVersion) {
            card(
                "Locations could not be loaded. Please try again.",
                "Map locations"
            );
        }
    }
}

// ======================================================
// SHARED TAB SWITCHING
// ======================================================

function showTab(tab) {
    activeTab = [
        "home",
        "abbrev",
        "emergency"
    ].includes(tab)
        ? tab
        : "home";

    for (const name of [
        "home",
        "abbrev",
        "emergency"
    ]) {
        const active = name === activeTab;

        hide(`${name}-screen`, !active);

        const mobile = el(`nav-${name}-btn`);

        mobile?.classList.toggle("text-wits-gold", active);
        mobile?.classList.toggle("font-bold", active);
        mobile?.classList.toggle("text-slate-400", !active);
        mobile?.classList.toggle("hover:text-wits-900", !active);

        const sidebar = el(`sidebar-${name}-btn`);

        if (sidebar) {
            sidebar.className =
                "w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm transition " +
                (
                    active
                        ? "bg-wits-gold text-wits-900 font-bold"
                        : "text-blue-100 hover:bg-white/10 font-medium"
                );
        }
    }

    try {
        sessionStorage.setItem(
            "witsNavActiveTab",
            activeTab
        );
    } catch {
        // Tabs still work if browser storage is unavailable.
    }
}

// ======================================================
// EMERGENCY FILTER
// ======================================================

let emergencyFilter = "medical";

function filterEmergency(selected) {
    const desktop = window.innerWidth >= 1024;

    emergencyFilter =
        desktop && selected === "contacts"
            ? "medical"
            : selected;

    for (const name of [
        "medical",
        "security",
        "contacts"
    ]) {
        const button = el(`filter-${name}-btn`);

        if (button) {
            button.className =
                "px-4 py-1.5 text-xs rounded-full whitespace-nowrap transition " +
                (
                    emergencyFilter === name
                        ? "font-bold bg-wits-900 text-white"
                        : "font-medium bg-white text-slate-600 border border-slate-200 hover:bg-slate-50"
                ) +
                (
                    name === "contacts"
                        ? " lg:hidden"
                        : ""
                );
        }
    }

    document
        .querySelectorAll('#emergency-screen [data-type]')
        .forEach(card => {
            card.classList.toggle(
                "hidden",
                card.dataset.type !== emergencyFilter
            );
        });

    const contacts = el("emergency-contacts-sidebar");

    if (contacts) {
        contacts.className = desktop
            ? "hidden lg:block bg-white border border-slate-200/80 rounded-2xl p-5 shadow-subtle sticky top-24"
            : emergencyFilter === "contacts"
                ? "block bg-white border border-slate-200/80 rounded-2xl p-5 shadow-subtle -mt-6"
                : "hidden";
    }
}

// ======================================================
// ABBREVIATION FILTER
// ======================================================

const abbreviationCards = Array.from(
    document.querySelectorAll(".abbrev-card"),
    card => ({
        card,

        search: normalise(
            `${card.querySelector("span")?.textContent} ` +
            `${card.querySelector("h4")?.textContent}`
        )
    })
);

// Keep global because the existing HTML uses oninput.
window.filterAbbreviations = query => {
    for (const item of abbreviationCards) {
        item.card.style.display =
            item.search.includes(normalise(query))
                ? ""
                : "none";
    }
};

// ======================================================
// EXISTING BUTTON HANDLERS
// ======================================================

for (const tab of [
    "home",
    "abbrev",
    "emergency"
]) {
    for (const prefix of ["nav", "sidebar"]) {
        el(`${prefix}-${tab}-btn`)?.addEventListener(
            "click",
            () => showTab(tab)
        );
    }
}

for (const type of [
    "medical",
    "security",
    "contacts"
]) {
    el(`filter-${type}-btn`)?.addEventListener(
        "click",
        () => filterEmergency(type)
    );
}

window.addEventListener("resize", () => {
    filterEmergency(emergencyFilter);
});

el("search-input").addEventListener(
    "input",
    updateSuggestions
);

el("search-input").addEventListener(
    "keydown",
    event => {
        if (
            event.key === "Enter" &&
            !event.isComposing
        ) {
            event.preventDefault();

            void searchDestination(
                event.target.value
            );
        }
    }
);

document.querySelectorAll(".quick-access").forEach(button => {
    button.addEventListener("click", () => {
        if (button.dataset.place === "Residences") {
            void showCategory(
                "residence",
                "Residences"
            );
        } else if (
            button.dataset.place === "Campus Entrances"
        ) {
            void showCategory(
                "entrance",
                "Campus Entrances"
            );
        } else if (
            button.dataset.place === "Emergency Services"
        ) {
            showTab("emergency");
        }
    });
});

document.querySelectorAll("[data-route-to]").forEach(button => {
    button.addEventListener("click", () => {
        const value = button.dataset.routeTo?.trim();

        if (!value) return;

        showTab("home");

        el("search-input").value = value;

        el("search-input").scrollIntoView({
            behavior: "smooth",
            block: "center"
        });

        void searchDestination(value);
    });
});

el("cancel-navigation-btn")?.addEventListener("click", () => {
    clearMap();

    el("search-input").value = "";
    el("location-suggestions").replaceChildren();

    if (map && goodFix()) {
        map.setCenter(latestFix);
        map.setZoom(16);
    }
});

el("recenter-button")?.addEventListener("click", () => {
    if (map) {
        map.setCenter(
            goodFix() ? latestFix : WITS_CENTRE
        );

        map.setZoom(16);
    }
});

// ======================================================
// STARTUP AND GPS FRESHNESS
// ======================================================

// GPS can become stale even when no error callback arrives.
setInterval(() => {
    if (!goodFix()) {
        nearSince = null;

        text(
            "gps-text",
            latestFix ? "GPS uncertain" : "Waiting for GPS"
        );

        if (
            route &&
            !finished &&
            !routeController
        ) {
            showStep(
                "Waiting for a fresh, accurate GPS reading."
            );
        }
    }
}, 5000);

resetStats();
text("gps-text", "Waiting for GPS");

filterEmergency(emergencyFilter);

let savedTab = "home";

try {
    savedTab =
        sessionStorage.getItem("witsNavActiveTab") ||
        "home";
} catch {
    // Use Home if browser storage is unavailable.
}

showTab(savedTab);

loadLocations()
    .then(updateSuggestions)
    .catch(() => {
        console.warn(
            "Location suggestions unavailable. Search still works."
        );
    });