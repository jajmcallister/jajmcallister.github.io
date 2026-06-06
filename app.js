const v = document.getElementById("v");
const c = document.getElementById("c");
const ctx = c.getContext("2d");

let center = null;
let radius = null;
let dragging = false;

/* =========================
   CAMERA
========================= */
navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment" }
}).then(stream => {
    v.srcObject = stream;
}).catch(err => console.error("Camera error:", err));

v.onloadedmetadata = () => {
    resize();
};

function resize(){
    const r = c.getBoundingClientRect();
    c.width = r.width;
    c.height = r.height;
    drawBase();
}

window.addEventListener("resize", resize);
setTimeout(resize, 500);

/* =========================
   COORDS
========================= */
function pos(e){
    const r = c.getBoundingClientRect();
    return {
        x: (e.clientX - r.left),
        y: (e.clientY - r.top)
    };
}

/* =========================
   INPUT (circle selection)
========================= */
c.addEventListener("pointerdown", (e) => {
    const p = pos(e);
    // Click again to reset and redraw a new pizza circle
    center = p;
    radius = 0;
    dragging = true;
});

c.addEventListener("pointermove", (e) => {
    if(!dragging || !center) return;

    const p = pos(e);
    radius = Math.hypot(p.x - center.x, p.y - center.y);
    drawBase();
});

c.addEventListener("pointerup", () => dragging = false);
c.addEventListener("pointercancel", () => dragging = false);

/* =========================
   BASE DRAW
========================= */
function drawBase(){
    ctx.clearRect(0, 0, c.width, c.height);

    if(center && radius){
        ctx.strokeStyle = "lime";
        ctx.lineWidth = 3;

        ctx.beginPath();
        ctx.arc(center.x, center.y, radius, 0, Math.PI*2);
        ctx.stroke();

        ctx.fillStyle = "red";
        ctx.beginPath();
        ctx.arc(center.x, center.y, 5, 0, Math.PI*2);
        ctx.fill();
    }
}

/* =========================
   MAIN VORONOI CVT (WITH AREA CORRECTION)
========================= */
/* =========================
   MAIN VORONOI CVT (WITH CHAOTIC EQUAL-AREA CORRECTION)
========================= */
/* =========================
   MAIN VORONOI CVT (WITH SIMULATED ANNEALING AREA EQUALIZATION)
========================= */
function generate(){
    if(!center || !radius || radius < 5){
        alert("Set pizza first");
        return;
    }

    const N = +document.getElementById("n").value;
    const step = 4; // Lower step = sharper cuts & lines, but slightly higher processing load

    // 1. INIT SEEDS
    let sites = Array.from({length:N}, () => randomPointInCircle());
    
    // Track dynamic weights for area correction (capacity-constrained weights)
    let weights = Array.from({length:N}, () => 1.0);

    const colors = Array.from(
        {length:N},
        (_,i) => `hsl(${i*360/N}, 85%, 55%)`
    );

    // 2. ANNEALED CAPACITY-CONSTRAINED LLOYD RELAXATION LOOP
    const loops = 30; // Increased loop count slightly to ensure absolute convergence on equal areas
    
    for(let iter=0; iter<loops; iter++){

        let accum = Array.from({length:N}, () => ({ x:0, y:0, count:0 }));
        let totalCount = 0;

        /* Match every pixel coordinate cluster to its target site */
        for(let y=0; y<c.height; y+=step){
            for(let x=0; x<c.width; x+=step){
                if(!inside(x,y)) continue;

                totalCount++;
                let best = 0;
                let bestD = Infinity;

                for(let i=0; i<N; i++){
                    const dx = x - sites[i].x;
                    const dy = y - sites[i].y;
                    
                    // Modulating distance using our area constraint scale factors (weights)
                    const d = (dx*dx + dy*dy) / weights[i];

                    if(d < bestD){
                        bestD = d;
                        best = i;
                    }
                }

                accum[best].x += x;
                accum[best].y += y;
                accum[best].count++;
            }
        }

        const targetCountPerCell = totalCount / N;

        // --- SIMULATED ANNEALING ENGINE ---
        // 'temperature' starts at 1.0 on loop 0 and smoothly drops to 0.0 by the end.
        // This gives us maximum structural chaos early on, and perfect area convergence late.
        const temperature = Math.max(0, 1.0 - (iter / (loops - 5))); 

        /* Adjust sites with custom random offsets + adapt area weights */
        for(let i=0; i<N; i++){
            if(accum[i].count > 0){
                // Calculate the true geometric center of this slice
                const trueCenterX = accum[i].x / accum[i].count;
                const trueCenterY = accum[i].y / accum[i].count;
                
                // Add a random push offset that cools down over time
                const chaosScale = radius * 0.45 * temperature; // Massive early chaos (45% of radius!)
                const randomAngle = Math.random() * Math.PI * 2;
                
                const chaosX = Math.cos(randomAngle) * chaosScale;
                const chaosY = Math.sin(randomAngle) * chaosScale;

                // Move the site toward its centroid, plus our cooled chaotic offset
                const rate = 0.25;
                sites[i].x = sites[i].x + (trueCenterX - sites[i].x) * rate + chaosX;
                sites[i].y = sites[i].y + (trueCenterY - sites[i].y) * rate + chaosY;
                
                // Ensure the chaos push didn't accidentally kick the seed out of the pizza entirely
                if (!inside(sites[i].x, sites[i].y)) {
                    sites[i] = randomPointInCircle();
                }
                
                // --- AREA EQUALIZER ---
                // As the temperature cools down, the area equalizer gets more aggressive
                const sizeRatio = accum[i].count / targetCountPerCell;
                const correctionForce = 0.35 + (1.0 - temperature) * 0.4; 
                weights[i] *= (1.0 + (1.0 - sizeRatio) * correctionForce); 
            } else {
                sites[i] = randomPointInCircle();
                weights[i] = 1.0;
            }
        }
    }

    // 3. FINAL REGION ASSIGNMENT & SECTOR CUT DISCOVERY
    let grid = [];
    for(let y=0; y<c.height; y+=step){
        for(let x=0; x<c.width; x+=step){
            if(!inside(x,y)) continue;

            let best = 0;
            let bestD = Infinity;

            for(let i=0; i<N; i++){
                const dx = x - sites[i].x;
                const dy = y - sites[i].y;
                const d = (dx*dx + dy*dy) / weights[i];

                if(d < bestD){
                    bestD = d;
                    best = i;
                }
            }
            grid.push({x, y, owner:best});
        }
    }

    draw(grid, colors, step);
}
/* =========================
   HELPERS
========================= */
function inside(x,y){
    const dx = x-center.x;
    const dy = y-center.y;
    return dx*dx + dy*dy <= radius*radius;
}

function randomPointInCircle(){
    const t = Math.random() * 2*Math.PI;
    const r = Math.sqrt(Math.random()) * radius * 0.8; // keep slightly inside for initial stability
    return {
        x: center.x + r*Math.cos(t),
        y: center.y + r*Math.sin(t)
    };
}

/* =========================
   RENDER
========================= */
function draw(grid, colors, step){
    // 1. Wipe previous frames
    ctx.clearRect(0, 0, c.width, c.height);

    // 2. Render colored grid blocks
    ctx.globalAlpha = 0.45;
    for(const cell of grid){
        ctx.fillStyle = colors[cell.owner];
        ctx.fillRect(cell.x, cell.y, step, step);
    }

    // 3. Render clean crisp white boundary cuts between cell territories
    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = "white";
    ctx.lineWidth = 2;

    // Detect pixel neighborhood changes to locate straight cutting edges
    for (const cell of grid) {
        // Look right and down to check if owner changes (edge detection)
        const checkPoints = [
            {x: cell.x + step, y: cell.y},
            {x: cell.x, y: cell.y + step}
        ];

        for(const pt of checkPoints) {
            if (inside(pt.x, pt.y)) {
                // Approximate hit test against local ownership array to see if border is reached
                const neighbor = grid.find(g => g.x === pt.x && g.y === pt.y);
                if (neighbor && neighbor.owner !== cell.owner) {
                    ctx.strokeRect(cell.x, cell.y, step, step);
                }
            }
        }
    }

    // 4. Draw guiding overlay parameters on top without clearing progress!
    ctx.globalAlpha = 1.0;
    
    ctx.strokeStyle = "lime";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(center.x, center.y, radius, 0, Math.PI*2);
    ctx.stroke();

    ctx.fillStyle = "red";
    ctx.beginPath();
    ctx.arc(center.x, center.y, 5, 0, Math.PI*2);
    ctx.fill();
}