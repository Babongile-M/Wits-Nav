const pack = require("express");
const server = pack();

const nodes = require("./nodes.json");
const connections = require("./connections.json");
const directions = require("./directions.json");

// Ensuring that Railway.app uses its custom port dynamically first before defaulting to port 4000 locally
const PORT = process.env.PORT || 4000;

server.listen(PORT, () => {
  console.log(`The server is running on port ${PORT}`);
});

function findRoute(current, To, visited, route) {

    visited.push(current);
    route.push(current);

    if (current === To) {
        return true;
    }

    let currentNode = null;

    for (let i = 0; i < connections.length; i++) {

        if (connections[i].alias === current) {
            currentNode = connections[i];
            break;
        }
    }

    if (currentNode === null) {
        route.pop();
        return false;
    }

    for (let i = 0; i < currentNode.connection.length; i++) {

        let nextNode = currentNode.connection[i];

        if (!visited.includes(nextNode)) {

            let found = findRoute(nextNode, To, visited, route);

            if (found === true) {
                return true;
            }
        }
    }

    route.pop();

    return false;
}

server.get("/buildings", (req, res) => {

    let From = null;
    let To = null;

    for (let i = 0; i < nodes.length; i++) {

        if (nodes[i].alias === req.query.from) {
            From = nodes[i].alias;
        }

        if (nodes[i].alias === req.query.to) {
            To = nodes[i].alias;
        }
    }

    if (From === null || To === null) {
        return res.status(404).json({
            error: "Invalid route"
        });
    }

    let route = [];
    let visited = [];

    let found = findRoute(From, To, visited, route);

if ( found ===false){
        res.status(404).json({
            error: "No route found"
        });
    }
    let instructions = [];
    for (let i=0; i<route.length-1; i++){
        let start = route[i];
        let next = route[i+1];
        for ( let j=0; j<directions.length; j++){
            if ( start === directions[j].from && next === directions[j].to){
                instructions.push(directions[j].instruction);
                break;
            }
        }

    }

res.json({
    from:From,
    to: To,
    route: route,
    directions : instructions
});

});