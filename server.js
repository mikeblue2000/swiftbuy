const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data.json');
const UPLOAD_DIR = path.join(ROOT, 'uploads');

const seedProducts = [
    {
        id: 1,
        name: "Aura Pro Wireless Headphones",
        category: "Electronics",
        price: 12999,
        oldPrice: 19999,
        rating: 4.8,
        reviews: 342,
        image: "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=600&q=80",
        flashSale: true,
        badge: "Flash Sale",
        stock: 42,
        description: "Active noise cancelling with 40-hour battery life and spatial audio immersion."
    },
    {
        id: 2,
        name: "Ultra-Light Performance Running Shoes",
        category: "Fashion",
        price: 8450,
        oldPrice: 12000,
        rating: 4.6,
        reviews: 189,
        image: "https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=600&q=80",
        flashSale: true,
        badge: "Best Seller",
        stock: 27,
        description: "Breathable mesh upper with high-rebound cushioning for maximum comfort."
    },
    {
        id: 3,
        name: "Smart Watch Series X - OLED Display",
        category: "Electronics",
        price: 24900,
        oldPrice: 29900,
        rating: 4.9,
        reviews: 512,
        image: "https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=600&q=80",
        flashSale: false,
        badge: "Trending",
        stock: 15,
        description: "Comprehensive health monitoring, GPS tracking, and seamless smartphone sync."
    },
    {
        id: 4,
        name: "Ergonomic Mechanical RGB Gaming Keyboard",
        category: "Gaming",
        price: 7999,
        oldPrice: 10999,
        rating: 4.7,
        reviews: 210,
        image: "https://images.unsplash.com/photo-1587829741301-dc798b83add3?auto=format&fit=crop&w=600&q=80",
        flashSale: true,
        badge: "Flash Sale",
        stock: 33,
        description: "Customizable hot-swappable tactile switches with customizable backlight profiles."
    },
    {
        id: 5,
        name: "Minimalist Top-Grain Leather Chronograph",
        category: "Fashion",
        price: 15900,
        oldPrice: 21000,
        rating: 4.8,
        reviews: 95,
        image: "https://images.unsplash.com/photo-1524805444758-089113d48a6d?auto=format&fit=crop&w=600&q=80",
        flashSale: false,
        badge: "Premium",
        stock: 12,
        description: "Water-resistant stainless steel watch with genuine top-grain calfskin leather strap."
    },
    {
        id: 6,
        name: "Precision Espresso & Coffee Machine",
        category: "Home & Kitchen",
        price: 18999,
        oldPrice: 24000,
        rating: 4.9,
        reviews: 142,
        image: "https://images.unsplash.com/photo-1517668808822-9ed02810a01d?auto=format&fit=crop&w=600&q=80",
        flashSale: true,
        badge: "Hot Item",
        stock: 18,
        description: "15-bar Italian pump pressure with built-in milk frother for barista quality at home."
    },
    {
        id: 7,
        name: "Hydrating Organic Glow Face Serum",
        category: "Beauty & Cosmetics",
        price: 3400,
        oldPrice: 4800,
        rating: 4.5,
        reviews: 88,
        image: "https://images.unsplash.com/photo-1620916566398-39f1143ab7be?auto=format&fit=crop&w=600&q=80",
        flashSale: false,
        badge: "Organic",
        stock: 64,
        description: "Infused with Hyaluronic Acid and Vitamin C for natural radiant skincare."
    },
    {
        id: 8,
        name: "Wireless Ergonomic Precision Mouse",
        category: "Gaming",
        price: 4999,
        oldPrice: 6999,
        rating: 4.6,
        reviews: 175,
        image: "https://images.unsplash.com/photo-1615663245857-ac93bb7c39e7?auto=format&fit=crop&w=600&q=80",
        flashSale: false,
        badge: "New Arrival",
        stock: 51,
        description: "Ultra-fast wireless sensor with 20,000 DPI and programmable side buttons."
    }
];

let db = { products: [], orders: [], users: [], coupons: [], newsletter: [], messages: [] };
const sessions = {}; // token -> { userId, expiresAt }
const SESSION_TTL = 7 * 24 * 3600000; // 7 days
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@swiftbuy.local').toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin@2026';
const rateHits = {}; // key -> { count, resetAt }

function rateLimit(key, max, windowMs) {
    const now = Date.now();
    let e = rateHits[key];
    if (!e || e.resetAt <= now) {
        e = { count: 0, resetAt: now + windowMs };
        rateHits[key] = e;
    }
    e.count++;
    return e.count <= max;
}

function rateKey(req, label) {
    return label + ':' + (req.socket.remoteAddress || 'unknown');
}

function cleanExpiredSessions() {
    const now = Date.now();
    for (const k of Object.keys(sessions)) {
        if (sessions[k].expiresAt <= now) delete sessions[k];
    }
    for (const k of Object.keys(rateHits)) {
        if (rateHits[k].resetAt <= now) delete rateHits[k];
    }
}
setInterval(cleanExpiredSessions, 10 * 60000).unref();

function loadDb() {
    try {
        const raw = fs.readFileSync(DATA_FILE, 'utf8');
        db = JSON.parse(raw);
    } catch (e) {
        db = { products: JSON.parse(JSON.stringify(seedProducts)), orders: [], users: [], coupons: [], newsletter: [], messages: [] };
        saveDb();
    }
    if (!Array.isArray(db.products) || db.products.length === 0) db.products = JSON.parse(JSON.stringify(seedProducts));
    let changed = false;
    db.products.forEach(p => {
        if (p.stock === undefined || p.stock === null) { p.stock = 10; changed = true; }
        if (typeof p.price !== 'number') { p.price = Number(p.price) || 0; changed = true; }
    });
    if (changed) saveDb();
    if (!Array.isArray(db.orders)) db.orders = [];
    if (!Array.isArray(db.users)) db.users = [];
    if (!Array.isArray(db.coupons)) db.coupons = [];
    if (!Array.isArray(db.newsletter)) db.newsletter = [];
    if (!Array.isArray(db.messages)) db.messages = [];
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

    if (!db.users.some(u => u.role === 'admin')) {
        const salt = crypto.randomBytes(16).toString('hex');
        db.users.push({
            id: nextId(db.users),
            name: 'SwiftBuy Admin',
            email: ADMIN_EMAIL,
            salt,
            passwordHash: hashPassword(ADMIN_PASSWORD, salt),
            role: 'admin',
            createdAt: Date.now()
        });
        saveDb();
        console.log('Seeded admin account: ' + ADMIN_EMAIL + ' (password from ADMIN_PASSWORD env or default). CHANGE THE DEFAULT PASSWORD!');
    }
}

function saveDb() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.txt': 'text/plain; charset=utf-8'
};

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', chunk => {
            chunks.push(chunk);
            size += chunk.length;
            if (size > 10 * 1024 * 1024) {
                reject(new Error('Payload too large'));
                req.destroy();
            }
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function readJson(req) {
    return readBody(req).then(buf => {
        try {
            return JSON.parse(buf.toString('utf8'));
        } catch (e) {
            return null;
        }
    });
}

function securityHeaders() {
    return {
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdnjs.cloudflare.com; font-src 'self' data: https://cdnjs.cloudflare.com; connect-src 'self' http://localhost:3000; base-uri 'self'; form-action 'self'"
    };
}

function sendJson(res, code, obj) {
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        ...securityHeaders()
    });
    res.end(JSON.stringify(obj));
}

function sendText(res, code, text) {
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(text);
}

function nextId(list) {
    return list.reduce((m, i) => Math.max(m, Number(i.id) || 0), 0) + 1;
}

function generateOrderCode() {
    // Kenyan number plate format: K + 2 letters + 3 digits + 1 letter, e.g. KDA123A
    const rand = (n) => Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
    for (let attempt = 0; attempt < 50; attempt++) {
        const code = 'K' + rand(2) + String(Math.floor(Math.random() * 1000)).padStart(3, '0') + rand(1);
        if (!db.orders.some(o => String(o.id).toUpperCase() === code)) return code;
    }
    return 'K' + rand(2) + String(Date.now() % 1000).padStart(3, '0') + rand(1);
}

function maskPhone(phone) {
    const p = String(phone || '');
    return p.length <= 4 ? p : p.slice(0, 4) + '****' + p.slice(-2);
}

function maskName(name) {
    const n = String(name || '');
    const parts = n.trim().split(/\s+/);
    if (parts.length === 0) return '';
    return parts[0] + (parts.length > 1 ? ' ' + parts[1].charAt(0) + '.' : '');
}

function maskAddress(address) {
    const a = String(address || '');
    return a.length <= 12 ? a : a.slice(0, 12) + '...';
}

function fmtTime(ms) {
    try {
        return new Date(ms).toLocaleString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric',
            hour: 'numeric', minute: '2-digit'
        });
    } catch (e) {
        return new Date(ms).toISOString();
    }
}

const HOUR = 3600000;
const STATUS_ORDER = ['processing', 'packed', 'shipped', 'delivered'];

function effectiveStatus(order) {
    if (order.status && STATUS_ORDER.includes(order.status)) return order.status;
    const elapsed = Date.now() - order.createdAt;
    if (elapsed < 2 * HOUR) return 'processing';
    if (elapsed < 6 * HOUR) return 'packed';
    if (elapsed < 12 * HOUR) return 'shipped';
    return 'delivered';
}

const STATUS_LABEL = {
    processing: 'Order Confirmed',
    packed: 'Packed at Fulfillment',
    shipped: 'Out for Delivery',
    delivered: 'Delivered'
};

function publicOrder(order, opts) {
    const mask = opts && opts.maskPII;
    const status = effectiveStatus(order);
    const idx = STATUS_ORDER.indexOf(status);
    const steps = [
        { label: 'Order Placed & Confirmed', time: fmtTime(order.createdAt) },
        { label: 'Packed at SwiftBuy Fulfillment Center', time: fmtTime(order.createdAt + 2 * HOUR) },
        { label: 'Out for Local Express Delivery', time: fmtTime(order.createdAt + 6 * HOUR) },
        { label: 'Delivered to Customer', time: 'Estimated ' + fmtTime(order.createdAt + 12 * HOUR) }
    ].map((s, i) => ({ ...s, done: i <= idx }));

    return {
        id: order.id,
        customer: mask
            ? {
                name: maskName(order.customer.name),
                phone: maskPhone(order.customer.phone),
                address: maskAddress(order.customer.address)
            }
            : order.customer,
        payment: order.payment,
        items: order.items,
        subtotal: order.subtotal,
        coupon: order.coupon || null,
        total: order.total,
        createdAt: order.createdAt,
        status,
        statusLabel: STATUS_LABEL[status],
        timeline: steps
    };
}

function validateProduct(body) {
    const name = (body.name || '').toString().trim();
    const price = Number(body.price);
    const image = (body.image || '').toString().trim();
    if (!name || !isFinite(price) || price <= 0 || !image) {
        return { error: 'name, price (positive number) and image are required' };
    }
    let stock = Number(body.stock);
    if (body.stock !== undefined && !isFinite(stock)) stock = 0;
    if (stock < 0) stock = 0;
    return {
        product: {
            name,
            category: (body.category || 'Electronics').toString(),
            badge: (body.badge || 'New Arrival').toString(),
            price,
            oldPrice: body.oldPrice ? Number(body.oldPrice) : null,
            image,
            description: (body.description || '').toString(),
            flashSale: !!body.flashSale,
            stock,
            rating: body.rating ? Number(body.rating) : 4.5,
            reviews: body.reviews ? Number(body.reviews) : 0
        }
    };
}

// ---------- AUTH ----------
function hashPassword(password, salt) {
    return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function createSession(userId) {
    const token = crypto.randomBytes(24).toString('hex');
    sessions[token] = { userId, expiresAt: Date.now() + SESSION_TTL };
    return token;
}

function authUser(req) {
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const session = sessions[token];
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
        delete sessions[token];
        return null;
    }
    const user = db.users.find(u => u.id === session.userId) || null;
    if (user && session.expiresAt - Date.now() < SESSION_TTL / 4) {
        session.expiresAt = Date.now() + SESSION_TTL;
    }
    return user;
}

function authAdmin(req) {
    const user = authUser(req);
    return user && user.role === 'admin' ? user : null;
}

function publicUser(u) {
    return { id: u.id, name: u.name, email: u.email, role: u.role || 'customer', createdAt: u.createdAt };
}

// ---------- STATS ----------
function computeStats() {
    const orders = db.orders;
    const revenue = orders.reduce((s, o) => s + (o.total || 0), 0);
    const unitsSold = orders.reduce((s, o) => s + o.items.reduce((a, i) => a + (i.qty || 0), 0), 0);
    const byProduct = {};
    orders.forEach(o => o.items.forEach(i => {
        const key = i.name || 'Unknown';
        byProduct[key] = byProduct[key] || { name: key, qty: 0, revenue: 0 };
        byProduct[key].qty += i.qty || 0;
        byProduct[key].revenue += (i.price || 0) * (i.qty || 0);
    }));
    const topProducts = Object.values(byProduct).sort((a, b) => b.qty - a.qty).slice(0, 5);
    const pending = orders.filter(o => !['shipped', 'delivered'].includes(effectiveStatus(o))).length;
    const delivered = orders.filter(o => effectiveStatus(o) === 'delivered').length;
    return {
        revenue,
        totalOrders: orders.length,
        unitsSold,
        pendingOrders: pending,
        deliveredOrders: delivered,
        topProducts
    };
}

const server = http.createServer(async (req, res) => {
    let pathname;
    try {
        pathname = decodeURIComponent(new URL(req.url, 'http://localhost:' + PORT).pathname);
    } catch (e) {
        return sendJson(res, 400, { error: 'Bad request' });
    }

    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            ...securityHeaders()
        });
        return res.end();
    }

    if (pathname === '/api/health') {
        return sendJson(res, 200, { ok: true, products: db.products.length, orders: db.orders.length, users: db.users.length, coupons: db.coupons.length });
    }

    // ---------------- AUTH ----------------
    if (pathname === '/api/auth/register' && req.method === 'POST') {
        if (!rateLimit(rateKey(req, 'reg'), 10, 60000)) {
            return sendJson(res, 429, { error: 'Too many attempts. Please wait a minute.' });
        }
        const body = await readJson(req);
        if (!body) return sendJson(res, 400, { error: 'Invalid JSON body' });
        const name = (body.name || '').toString().trim();
        const email = (body.email || '').toString().trim().toLowerCase();
        const password = (body.password || '').toString();
        if (!name || !email.includes('@') || password.length < 8) {
            return sendJson(res, 400, { error: 'Name, valid email and a password of at least 8 characters are required' });
        }
        if (db.users.some(u => u.email === email)) {
            return sendJson(res, 409, { error: 'An account with this email already exists. Try signing in.' });
        }
        const salt = crypto.randomBytes(16).toString('hex');
        const user = { id: nextId(db.users), name, email, salt, passwordHash: hashPassword(password, salt), role: 'customer', createdAt: Date.now() };
        db.users.push(user);
        saveDb();
        const token = createSession(user.id);
        return sendJson(res, 201, { token, user: publicUser(user) });
    }

    if (pathname === '/api/auth/login' && req.method === 'POST') {
        if (!rateLimit(rateKey(req, 'login'), 10, 60000)) {
            return sendJson(res, 429, { error: 'Too many attempts. Please wait a minute.' });
        }
        const body = await readJson(req);
        if (!body) return sendJson(res, 400, { error: 'Invalid JSON body' });
        const email = (body.email || '').toString().trim().toLowerCase();
        const password = (body.password || '').toString();
        const user = db.users.find(u => u.email === email);
        if (!user || !user.passwordHash || user.passwordHash !== hashPassword(password, user.salt)) {
            return sendJson(res, 401, { error: 'Incorrect email or password' });
        }
        const token = createSession(user.id);
        return sendJson(res, 200, { token, user: publicUser(user) });
    }

    if (pathname === '/api/auth/password' && req.method === 'PUT') {
        const user = authUser(req);
        if (!user) return sendJson(res, 401, { error: 'Not signed in' });
        const body = await readJson(req);
        if (!body) return sendJson(res, 400, { error: 'Invalid JSON body' });
        const password = (body.password || '').toString();
        if (password.length < 8) {
            return sendJson(res, 400, { error: 'Password must be at least 8 characters' });
        }
        const salt = crypto.randomBytes(16).toString('hex');
        user.salt = salt;
        user.passwordHash = hashPassword(password, salt);
        saveDb();
        return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/auth/me' && req.method === 'GET') {
        const user = authUser(req);
        if (!user) return sendJson(res, 401, { error: 'Not signed in' });
        return sendJson(res, 200, publicUser(user));
    }

    if (pathname === '/api/auth/logout' && req.method === 'POST') {
        const header = req.headers['authorization'] || '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : '';
        delete sessions[token];
        return sendJson(res, 200, { ok: true });
    }

    // ---------------- PRODUCTS ----------------
    if (pathname === '/api/products' && req.method === 'GET') {
        return sendJson(res, 200, db.products);
    }

    if (pathname === '/api/products' && req.method === 'POST') {
        if (!authAdmin(req)) return sendJson(res, 401, { error: 'Admin access required' });
        const body = await readJson(req);
        if (!body) return sendJson(res, 400, { error: 'Invalid JSON body' });
        const check = validateProduct(body);
        if (check.error) return sendJson(res, 400, { error: check.error });
        const product = { id: nextId(db.products), ...check.product };
        db.products.unshift(product);
        saveDb();
        return sendJson(res, 201, product);
    }

    let productsMatch = pathname.match(/^\/api\/products\/(\d+)$/);
    if (productsMatch) {
        const pid = Number(productsMatch[1]);
        const idx = db.products.findIndex(p => Number(p.id) === pid);
        if (idx === -1) return sendJson(res, 404, { error: 'Product not found' });

        if (req.method === 'PUT') {
            if (!authAdmin(req)) return sendJson(res, 401, { error: 'Admin access required' });
            const body = await readJson(req);
            if (!body) return sendJson(res, 400, { error: 'Invalid JSON body' });
            const check = validateProduct(body);
            if (check.error) return sendJson(res, 400, { error: check.error });
            db.products[idx] = { ...db.products[idx], ...check.product, id: pid };
            saveDb();
            return sendJson(res, 200, db.products[idx]);
        }

        if (req.method === 'DELETE') {
            if (!authAdmin(req)) return sendJson(res, 401, { error: 'Admin access required' });
            const [removed] = db.products.splice(idx, 1);
            db.orders.forEach(o => {
                o.items = o.items.filter(i => Number(i.id) !== pid);
            });
            saveDb();
            return sendJson(res, 200, { deleted: true, id: pid, name: removed.name });
        }

        return sendJson(res, 405, { error: 'Method not allowed' });
    }

    // ---------------- ORDERS ----------------
    if (pathname === '/api/orders' && req.method === 'GET') {
        if (!authAdmin(req)) return sendJson(res, 401, { error: 'Admin access required' });
        return sendJson(res, 200, db.orders.slice().reverse().map(o => publicOrder(o, { maskPII: false })));
    }

    if (pathname === '/api/orders' && req.method === 'POST') {
        const body = await readJson(req);
        if (!body) return sendJson(res, 400, { error: 'Invalid JSON body' });
        const name = (body.name || '').toString().trim();
        const phone = (body.phone || '').toString().trim();
        const address = (body.address || '').toString().trim();
        const payment = (body.payment || 'mpesa').toString();
        const items = Array.isArray(body.items) && body.items.length ? body.items : null;

        if (!name || !phone || !address || !items) {
            return sendJson(res, 400, { error: 'name, phone, address and at least one item are required' });
        }

        // stock check + decrement
        const verified = [];
        for (const i of items) {
            const prod = db.products.find(p => Number(p.id) === Number(i.id));
            if (!prod) return sendJson(res, 400, { error: 'Product not found in inventory' });
            const qty = Math.max(1, Math.min(Number(i.qty) || 1, 99));
            const stock = (prod.stock === undefined || prod.stock === null) ? 9999 : prod.stock;
            if (qty > stock) {
                return sendJson(res, 409, { error: `Insufficient stock for "${prod.name}" (only ${stock} left)` });
            }
            prod.stock = stock - qty;
            verified.push({ id: prod.id, name: prod.name, price: prod.price, qty, image: prod.image });
        }

        const subtotal = verified.reduce((s, i) => s + (Number(i.price) * i.qty), 0);

        // coupon
        let coupon = null;
        let total = subtotal;
        if (body.couponCode) {
            const code = String(body.couponCode).trim().toUpperCase();
            const c = db.coupons.find(x => String(x.code).toUpperCase() === code && x.active);
            if (c) {
                const discount = Math.round(subtotal * (c.percent / 100));
                total = subtotal - discount;
                coupon = { code: c.code, percent: c.percent, discount };
            }
        }

        const order = {
            id: generateOrderCode(),
            customer: { name, phone, address },
            payment,
            items: verified,
            subtotal,
            coupon,
            total,
            status: null,
            createdAt: Date.now()
        };
        db.orders.push(order);
        saveDb();
        return sendJson(res, 201, publicOrder(order));
    }

    let ordersMatch = pathname.match(/^\/api\/orders\/([\w-]+)$/);
    if (ordersMatch) {
        const code = ordersMatch[1].toUpperCase();
        const idx = db.orders.findIndex(o => String(o.id).toUpperCase() === code);
        if (idx === -1) return sendJson(res, 404, { error: 'Order not found' });

        if (req.method === 'GET') {
            if (!rateLimit(rateKey(req, 'track'), 30, 60000)) {
                return sendJson(res, 429, { error: 'Too many tracking lookups. Please slow down.' });
            }
            return sendJson(res, 200, publicOrder(db.orders[idx], { maskPII: true }));
        }

        if (req.method === 'PUT') {
            if (!authAdmin(req)) return sendJson(res, 401, { error: 'Admin access required' });
            const body = await readJson(req);
            if (!body) return sendJson(res, 400, { error: 'Invalid JSON body' });
            if (body.status && !STATUS_ORDER.includes(body.status)) {
                return sendJson(res, 400, { error: 'Invalid status' });
            }
            db.orders[idx].status = body.status || null;
            saveDb();
            return sendJson(res, 200, publicOrder(db.orders[idx], { maskPII: false }));
        }

        return sendJson(res, 405, { error: 'Method not allowed' });
    }

    // ---------------- COUPONS ----------------
    if (pathname === '/api/coupons' && req.method === 'GET') {
        if (!authAdmin(req)) return sendJson(res, 401, { error: 'Admin access required' });
        return sendJson(res, 200, db.coupons);
    }

    if (pathname === '/api/coupons' && req.method === 'POST') {
        if (!authAdmin(req)) return sendJson(res, 401, { error: 'Admin access required' });
        const body = await readJson(req);
        if (!body) return sendJson(res, 400, { error: 'Invalid JSON body' });
        const code = (body.code || '').toString().trim().toUpperCase();
        const percent = Number(body.percent);
        if (!/^[A-Z0-9]{3,15}$/.test(code) || !isFinite(percent) || percent <= 0 || percent > 90) {
            return sendJson(res, 400, { error: 'Code must be 3-15 letters/numbers and discount must be 1-90%' });
        }
        if (db.coupons.some(c => String(c.code).toUpperCase() === code)) {
            return sendJson(res, 409, { error: 'Coupon code already exists' });
        }
        const coupon = { id: nextId(db.coupons), code, percent, active: body.active !== false, createdAt: Date.now() };
        db.coupons.push(coupon);
        saveDb();
        return sendJson(res, 201, coupon);
    }

    let couponMatch = pathname.match(/^\/api\/coupons\/(\d+)$/);
    if (couponMatch) {
        const cid = Number(couponMatch[1]);
        const idx = db.coupons.findIndex(c => Number(c.id) === cid);
        if (idx === -1) return sendJson(res, 404, { error: 'Coupon not found' });

        if (req.method === 'PUT') {
            if (!authAdmin(req)) return sendJson(res, 401, { error: 'Admin access required' });
            const body = await readJson(req);
            if (!body) return sendJson(res, 400, { error: 'Invalid JSON body' });
            if (body.active !== undefined) db.coupons[idx].active = !!body.active;
            if (body.percent !== undefined) db.coupons[idx].percent = Number(body.percent);
            if (body.code) db.coupons[idx].code = String(body.code).trim().toUpperCase();
            saveDb();
            return sendJson(res, 200, db.coupons[idx]);
        }

        if (req.method === 'DELETE') {
            if (!authAdmin(req)) return sendJson(res, 401, { error: 'Admin access required' });
            const [removed] = db.coupons.splice(idx, 1);
            saveDb();
            return sendJson(res, 200, { deleted: true, code: removed.code });
        }

        return sendJson(res, 405, { error: 'Method not allowed' });
    }

    if (pathname === '/api/coupons/validate' && req.method === 'POST') {
        const body = await readJson(req);
        if (!body) return sendJson(res, 400, { error: 'Invalid JSON body' });
        const code = (body.code || '').toString().trim().toUpperCase();
        const c = db.coupons.find(x => String(x.code).toUpperCase() === code && x.active);
        if (!c) return sendJson(res, 404, { error: 'Invalid or expired coupon code' });
        return sendJson(res, 200, { code: c.code, percent: c.percent });
    }

    // ---------------- STATS ----------------
    if (pathname === '/api/stats' && req.method === 'GET') {
        if (!authAdmin(req)) return sendJson(res, 401, { error: 'Admin access required' });
        return sendJson(res, 200, computeStats());
    }

    // ---------------- UPLOADS ----------------
    if (pathname === '/api/upload' && req.method === 'POST') {
        if (!authAdmin(req)) return sendJson(res, 401, { error: 'Admin access required' });
        const rawName = (req.headers['x-filename'] || 'image.jpg').toString().split(/[\\/]/).pop().toLowerCase();
        const ext = path.extname(rawName) || '.jpg';
        if (!['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
            return sendJson(res, 400, { error: 'Only image files are allowed (jpg, png, gif, webp)' });
        }
        const buf = await readBody(req);
        if (!buf || buf.length === 0) return sendJson(res, 400, { error: 'Empty upload' });
        if (buf.length > 5 * 1024 * 1024) return sendJson(res, 400, { error: 'Image must be under 5 MB' });
        // magic byte validation so file contents match the claimed extension
        const B = buf;
        const magicOk =
            ((ext === '.jpg' || ext === '.jpeg') && B.length > 3 && B[0] === 0xFF && B[1] === 0xD8 && B[2] === 0xFF) ||
            (ext === '.png' && B.length > 8 && B[0] === 0x89 && B[1] === 0x50 && B[2] === 0x4E && B[3] === 0x47) ||
            (ext === '.gif' && B.length > 6 && B[0] === 0x47 && B[1] === 0x49 && B[2] === 0x46 && B[3] === 0x38) ||
            (ext === '.webp' && B.length > 12 && B[0] === 0x52 && B[1] === 0x49 && B[2] === 0x46 && B[3] === 0x46 && B[8] === 0x57 && B[9] === 0x45 && B[10] === 0x42 && B[11] === 0x50);
        if (!magicOk) {
            return sendJson(res, 400, { error: 'File contents do not match the image type' });
        }
        const filename = Date.now() + '-' + crypto.randomBytes(4).toString('hex') + ext;
        fs.writeFileSync(path.join(UPLOAD_DIR, filename), buf);
        return sendJson(res, 201, { url: '/uploads/' + filename });
    }

    // ---------------- NEWSLETTER & CONTACT ----------------
    if (pathname === '/api/newsletter' && req.method === 'POST') {
        const body = await readJson(req);
        if (!body) return sendJson(res, 400, { error: 'Invalid JSON body' });
        const email = (body.email || '').toString().trim();
        if (!email || !email.includes('@')) return sendJson(res, 400, { error: 'Valid email required' });
        if (!db.newsletter.some(e => e.email === email)) db.newsletter.push({ email, at: Date.now() });
        saveDb();
        return sendJson(res, 201, { ok: true });
    }

    if (pathname === '/api/contact' && req.method === 'POST') {
        const body = await readJson(req);
        if (!body) return sendJson(res, 400, { error: 'Invalid JSON body' });
        const name = (body.name || '').toString().trim();
        const email = (body.email || '').toString().trim();
        const message = (body.message || '').toString().trim();
        if (!name || !email || !message) return sendJson(res, 400, { error: 'name, email and message required' });
        db.messages.push({ name, email, message, at: Date.now() });
        saveDb();
        return sendJson(res, 201, { ok: true });
    }

    // ---------------- STATIC FILES ----------------
    if (pathname.startsWith('/api/')) {
        return sendJson(res, 404, { error: 'Unknown API endpoint' });
    }

    let filePath = pathname === '/' ? path.join(ROOT, 'index.html') : path.normalize(path.join(ROOT, pathname));
    if (!filePath.startsWith(ROOT)) {
        return sendText(res, 403, 'Forbidden');
    }

    fs.readFile(filePath, (err, content) => {
        if (err) {
            return sendText(res, 404, 'Not found');
        }
        const ext = path.extname(filePath).toLowerCase();
        const isUpload = filePath.startsWith(path.join(ROOT, 'uploads'));
        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Cache-Control': 'no-cache',
            ...(isUpload ? { 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' } : securityHeaders())
        });
        res.end(content);
    });
});

loadDb();

server.listen(PORT, '0.0.0.0', () => {
     console.log('Abumira server running at http://0.0.0.0:' + PORT);
    console.log('Products: ' + db.products.length + ' | Users: ' + db.users.length + ' | Coupons: ' + db.coupons.length);
});
