const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data.json');
const UPLOAD_DIR = path.join(ROOT, 'uploads');

const SESSION_TTL = 7 * 24 * 3600000;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@swiftbuy.local').toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin@2026';
const rateHits = {};

const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY || '';
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET || '';
const MPESA_SHORTCODE = process.env.MPESA_SHORTCODE || '174379';
const MPESA_PASSKEY = process.env.MPESA_PASSKEY || '';
const MPESA_CALLBACK_URL = process.env.MPESA_CALLBACK_URL || '';
const MPESA_ENV = process.env.MPESA_ENV || 'sandbox';
const MPESA_BASE_URL = MPESA_ENV === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
let mpesaAccessToken = '';
let mpesaTokenExpiry = 0;

let db = { users: [], sellers: [], products: [], categories: [], orders: [], orderItems: [], cart: [], reviews: [], coupons: [], newsletter: [], messages: [], payments: [] };
const sessions = {};

function rateLimit(key, max, windowMs) {
    const now = Date.now();
    let e = rateHits[key];
    if (!e || e.resetAt <= now) { e = { count: 0, resetAt: now + windowMs }; rateHits[key] = e; }
    e.count++;
    return e.count <= max;
}
function rateKey(req) { return (req.socket.remoteAddress || 'unknown') + ':' + Date.now(); }
function nextId(list) { return list.reduce((m, i) => Math.max(m, Number(i.id) || 0), 0) + 1; }
function hashPassword(password, salt) { return crypto.scryptSync(String(password), salt, 64).toString('hex'); }
function createSession(userId) { const token = crypto.randomBytes(24).toString('hex'); sessions[token] = { userId, expiresAt: Date.now() + SESSION_TTL }; return token; }
function authUser(req) {
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const session = sessions[token];
    if (!session || session.expiresAt <= Date.now()) { delete sessions[token]; return null; }
    const user = db.users.find(u => u.id === session.userId) || null;
    if (user && session.expiresAt - Date.now() < SESSION_TTL / 4) session.expiresAt = Date.now() + SESSION_TTL;
    return user;
}
function authAdmin(req) { const u = authUser(req); return u && u.role === 'admin' ? u : null; }
function authSeller(req) { const u = authUser(req); return u && (u.role === 'seller' || u.role === 'admin') ? u : null; }
function saveDb() { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); }
function loadDb() {
    try { const raw = fs.readFileSync(DATA_FILE, 'utf8'); db = JSON.parse(raw); } catch (e) { db = seedDb(); }
    if (!Array.isArray(db.users)) db.users = [];
    if (!Array.isArray(db.sellers)) db.sellers = [];
    if (!Array.isArray(db.products)) db.products = [];
    if (!Array.isArray(db.categories)) db.categories = seedCategories();
    if (!Array.isArray(db.orders)) db.orders = [];
    if (!Array.isArray(db.orderItems)) db.orderItems = [];
    if (!Array.isArray(db.cart)) db.cart = [];
    if (!Array.isArray(db.reviews)) db.reviews = [];
    if (!Array.isArray(db.coupons)) db.coupons = [];
    if (!Array.isArray(db.newsletter)) db.newsletter = [];
    if (!Array.isArray(db.messages)) db.messages = [];
    if (!Array.isArray(db.payments)) db.payments = [];
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    if (!db.users.some(u => u.role === 'admin')) {
        const salt = crypto.randomBytes(16).toString('hex');
        db.users.push({ id: nextId(db.users), name: 'SwiftBuy Admin', email: ADMIN_EMAIL, salt, passwordHash: hashPassword(ADMIN_PASSWORD, salt), role: 'admin', createdAt: Date.now() });
    }
    if (db.categories.length === 0) { db.categories = seedCategories(); }
    saveDb();
}
function seedDb() {
    return { users: [], sellers: [], products: [], categories: seedCategories(), orders: [], orderItems: [], cart: [], reviews: [], coupons: [], newsletter: [], messages: [], payments: [] };
}
function seedCategories() {
    return [
        { id: 1, name: 'Electronics', slug: 'electronics', icon: 'fa-solid fa-microchip' },
        { id: 2, name: 'Fashion', slug: 'fashion', icon: 'fa-solid fa-shirt' },
        { id: 3, name: 'Gaming', slug: 'gaming', icon: 'fa-solid fa-gamepad' },
        { id: 4, name: 'Home & Kitchen', slug: 'home-kitchen', icon: 'fa-solid fa-kitchen-set' },
        { id: 5, name: 'Beauty & Cosmetics', slug: 'beauty', icon: 'fa-solid fa-spa' },
        { id: 6, name: 'Sports & Outdoors', slug: 'sports', icon: 'fa-solid fa-futbol' },
        { id: 7, name: 'Books & Stationery', slug: 'books', icon: 'fa-solid fa-book' },
        { id: 8, name: 'Phones & Accessories', slug: 'phones', icon: 'fa-solid fa-mobile-screen' },
        { id: 9, name: 'Automotive', slug: 'automotive', icon: 'fa-solid fa-car' },
        { id: 10, name: 'Toys & Kids', slug: 'toys', icon: 'fa-solid fa-baby' },
    ];
}
function fmtTime(ms) { try { return new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) { return new Date(ms).toISOString(); } }
function effectiveStatus(order) {
    if (order.status && STATUS_ORDER.includes(order.status)) return order.status;
    const elapsed = Date.now() - order.createdAt;
    if (elapsed < 2 * HOUR) return 'processing';
    if (elapsed < 6 * HOUR) return 'packed';
    if (elapsed < 12 * HOUR) return 'shipped';
    return 'delivered';
}
const STATUS_LABEL = { pending: 'Pending', confirmed: 'Confirmed', processing: 'Processing', packed: 'Packed', shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled' };

function sendJson(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdnjs.cloudflare.com; font-src 'self' data: https://cdnjs.cloudflare.com; base-uri 'self'; form-action 'self'" });
    res.end(JSON.stringify(obj));
}
function readBody(req) { return new Promise((resolve, reject) => { const chunks = []; let size = 0; req.on('data', chunk => { chunks.push(chunk); size += chunk.length; if (size > 10 * 1024 * 1024) { reject(new Error('Payload too large')); req.destroy(); } }); req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject); }); }
function readJson(req) { return readBody(req).then(buf => { try { return JSON.parse(buf.toString('utf8')); } catch (e) { return null; } }); }
function sanitize(str) { if (typeof str !== 'string') return ''; return str.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c])).substring(0, 500); }

const server = http.createServer(async (req, res) => {
    let pathname;
    let query = {};
    try { const urlObj = new URL(req.url, 'http://localhost:' + PORT); pathname = urlObj.pathname; query = Object.fromEntries(urlObj.searchParams.entries()); } catch (e) { return sendJson(res, 400, { error: 'Bad request' }); }
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' }); return res.end(); }

    if (pathname === '/api/health') return sendJson(res, 200, { ok: true, products: db.products.length, orders: db.orders.length, users: db.users.length, sellers: db.sellers.length });

    // AUTH
    if (pathname === '/api/auth/register' && req.method === 'POST') {
        if (!rateLimit('reg:' + (req.socket.remoteAddress || 'unknown'), 10, 60000)) return sendJson(res, 429, { error: 'Too many attempts.' });
        const body = await readJson(req);
        if (!body) return sendJson(res, 400, { error: 'Invalid JSON' });
        const name = sanitize(body.name);
        const email = sanitize(body.email).toLowerCase();
        const password = String(body.password || '');
        const role = (body.role || 'user').toString();
        if (!name || !email.includes('@') || password.length < 8) return sendJson(res, 400, { error: 'Name, valid email and password (min 8 chars) required' });
        if (db.users.some(u => u.email === email)) return sendJson(res, 409, { error: 'Email already registered' });
        const salt = crypto.randomBytes(16).toString('hex');
        const user = { id: nextId(db.users), name, email, salt, passwordHash: hashPassword(password, salt), role, createdAt: Date.now() };
        db.users.push(user);
        if (role === 'seller') {
            db.sellers.push({ id: user.id, userId: user.id, storeName: sanitize(body.storeName || name), description: sanitize(body.description || ''), profileImage: null, rating: 0, reviewCount: 0, isActive: true, isApproved: role === 'admin' || role === 'seller', createdAt: Date.now() });
        }
        saveDb();
        const token = createSession(user.id);
        return sendJson(res, 201, { token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
    }

    if (pathname === '/api/auth/login' && req.method === 'POST') {
        if (!rateLimit('login:' + (req.socket.remoteAddress || 'unknown'), 10, 60000)) return sendJson(res, 429, { error: 'Too many attempts.' });
        const body = await readJson(req);
        if (!body) return sendJson(res, 400, { error: 'Invalid JSON' });
        const email = sanitize(body.email).toLowerCase();
        const password = String(body.password || '');
        const user = db.users.find(u => u.email === email);
        if (!user || !user.passwordHash || user.passwordHash !== hashPassword(password, user.salt)) return sendJson(res, 401, { error: 'Invalid credentials' });
        const token = createSession(user.id);
        return sendJson(res, 200, { token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
    }

    if (pathname === '/api/auth/me' && req.method === 'GET') {
        const user = authUser(req);
        if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
        const seller = db.sellers.find(s => s.userId === user.id) || null;
        return sendJson(res, 200, { id: user.id, name: user.name, email: user.email, role: user.role, seller: seller ? { id: seller.id, storeName: seller.storeName, description: seller.description, profileImage: seller.profileImage, rating: seller.rating, isApproved: seller.isApproved, isActive: seller.isActive } : null });
    }

    if (pathname === '/api/auth/logout' && req.method === 'POST') {
        const header = req.headers['authorization'] || '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : '';
        delete sessions[token];
        return sendJson(res, 200, { ok: true });
    }

    // CATEGORIES
    if (pathname === '/api/categories' && req.method === 'GET') return sendJson(res, 200, db.categories);

    // SELLERS
    if (pathname === '/api/sellers/me' && req.method === 'GET') {
        const user = authUser(req); if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
        const seller = db.sellers.find(s => s.userId === user.id);
        return sendJson(res, 200, seller || { id: null, storeName: '', description: '', profileImage: null, rating: 0, reviewCount: 0, isActive: false, isApproved: false });
    }
    if (pathname === '/api/sellers/me' && req.method === 'PUT') {
        const user = authUser(req); if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
        const body = await readJson(req); if (!body) return sendJson(res, 400, { error: 'Invalid JSON' });
        const seller = db.sellers.find(s => s.userId === user.id);
        if (!seller) return sendJson(res, 404, { error: 'Seller profile not found' });
        if (body.storeName) seller.storeName = sanitize(body.storeName);
        if (body.description) seller.description = sanitize(body.description);
        saveDb();
        return sendJson(res, 200, { ok: true, seller });
    }
    if (pathname === '/api/sellers' && req.method === 'GET') {
        const sellers = db.sellers.filter(s => s.isApproved && s.isActive).map(s => ({ id: s.id, storeName: s.storeName, description: s.description, profileImage: s.profileImage, rating: s.rating, reviewCount: s.reviewCount, userId: s.userId }));
        return sendJson(res, 200, sellers);
    }

    // PRODUCTS
    if (pathname === '/api/products' && req.method === 'GET') {
        let products = db.products.filter(p => p.status === 'approved');
        const cat = req.query && req.query.category;
        if (cat) products = products.filter(p => p.category === cat);
        const q = req.query && req.query.q;
        if (q) { const sq = q.toLowerCase(); products = products.filter(p => p.name.toLowerCase().includes(sq) || p.description.toLowerCase().includes(sq)); }
        const sort = req.query && req.query.sort;
        if (sort === 'price-low') products.sort((a, b) => a.price - b.price);
        else if (sort === 'price-high') products.sort((a, b) => b.price - a.price);
        else if (sort === 'newest') products.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        else if (sort === 'rating') products.sort((a, b) => (b.rating || 0) - (a.rating || 0));
        return sendJson(res, 200, products);
    }

    if (pathname === '/api/products' && req.method === 'POST') {
        const user = authSeller(req); if (!user) return sendJson(res, 401, { error: 'Seller access required' });
        const body = await readJson(req); if (!body) return sendJson(res, 400, { error: 'Invalid JSON' });
        const product = {
            id: nextId(db.products), sellerId: user.id,
            name: sanitize(body.name), description: sanitize(body.description),
            category: sanitize(body.category), subcategory: sanitize(body.subcategory || ''),
            price: Number(body.price) || 0, discountPrice: Number(body.discountPrice) || 0,
            stock: Number(body.stock) || 0, condition: sanitize(body.condition || 'New'),
            sku: sanitize(body.sku || ''), images: Array.isArray(body.images) ? body.images.map(s => sanitize(s)) : [],
            colors: Array.isArray(body.colors) ? body.colors.map(s => sanitize(s)) : [],
            sizes: Array.isArray(body.sizes) ? body.sizes.map(s => sanitize(s)) : [],
            weight: sanitize(body.weight || ''), deliveryInfo: sanitize(body.deliveryInfo || ''),
            status: 'pending', createdAt: Date.now(), updatedAt: Date.now(),
            rating: 0, reviewCount: 0
        };
        db.products.push(product);
        saveDb();
        return sendJson(res, 201, product);
    }

    let productMatch = pathname.match(/^\/api\/products\/(\d+)$/);
    if (productMatch) {
        const pid = Number(productMatch[1]);
        const idx = db.products.findIndex(p => Number(p.id) === pid);
        if (idx === -1) return sendJson(res, 404, { error: 'Product not found' });
        const prod = db.products[idx];

        if (req.method === 'GET') return sendJson(res, 200, prod);

        if (req.method === 'PUT') {
            const user = authSeller(req); if (!user) return sendJson(res, 401, { error: 'Seller access required' });
            if (prod.sellerId !== user.id && user.role !== 'admin') return sendJson(res, 403, { error: 'Cannot edit this product' });
            const body = await readJson(req); if (!body) return sendJson(res, 400, { error: 'Invalid JSON' });
            if (body.name) prod.name = sanitize(body.name);
            if (body.description) prod.description = sanitize(body.description);
            if (body.category) prod.category = sanitize(body.category);
            if (body.subcategory !== undefined) prod.subcategory = sanitize(body.subcategory);
            if (body.price !== undefined) prod.price = Number(body.price) || 0;
            if (body.discountPrice !== undefined) prod.discountPrice = Number(body.discountPrice) || 0;
            if (body.stock !== undefined) prod.stock = Number(body.stock) || 0;
            if (body.condition) prod.condition = sanitize(body.condition);
            if (body.sku !== undefined) prod.sku = sanitize(body.sku);
            if (Array.isArray(body.images)) prod.images = body.images.map(s => sanitize(s));
            if (Array.isArray(body.colors)) prod.colors = body.colors.map(s => sanitize(s));
            if (Array.isArray(body.sizes)) prod.sizes = body.sizes.map(s => sanitize(s));
            if (body.weight !== undefined) prod.weight = sanitize(body.weight);
            if (body.deliveryInfo !== undefined) prod.deliveryInfo = sanitize(body.deliveryInfo);
            prod.updatedAt = Date.now();
            saveDb();
            return sendJson(res, 200, prod);
        }

        if (req.method === 'DELETE') {
            const user = authSeller(req); if (!user) return sendJson(res, 401, { error: 'Seller access required' });
            if (prod.sellerId !== user.id && user.role !== 'admin') return sendJson(res, 403, { error: 'Cannot delete this product' });
            db.products.splice(idx, 1);
            saveDb();
            return sendJson(res, 200, { deleted: true });
        }
    }

    // Seller's products
    if (pathname === '/api/products/seller' && req.method === 'GET') {
        const user = authSeller(req); if (!user) return sendJson(res, 401, { error: 'Seller access required' });
        const products = db.products.filter(p => p.sellerId === user.id);
        return sendJson(res, 200, products);
    }

    // Approve/reject product (admin)
    let productActionMatch = pathname.match(/^\/api\/products\/(\d+)\/(approve|reject)$/);
    if (productActionMatch && req.method === 'PUT') {
        const user = authAdmin(req); if (!user) return sendJson(res, 401, { error: 'Admin access required' });
        const pid = Number(productActionMatch[1]);
        const action = productActionMatch[2];
        const prod = db.products.find(p => Number(p.id) === pid);
        if (!prod) return sendJson(res, 404, { error: 'Product not found' });
        prod.status = action === 'approve' ? 'approved' : 'rejected';
        prod.updatedAt = Date.now();
        saveDb();
        return sendJson(res, 200, { ok: true, product: prod });
    }

    // Pending products (admin)
    if (pathname === '/api/products/pending' && req.method === 'GET') {
        const user = authAdmin(req); if (!user) return sendJson(res, 401, { error: 'Admin access required' });
        return sendJson(res, 200, db.products.filter(p => p.status === 'pending'));
    }

    // Product stats (admin)
    if (pathname === '/api/products/stats' && req.method === 'GET') {
        const user = authSeller(req); if (!user && !authAdmin(req)) return sendJson(res, 401, { error: 'Access required' });
        const sellerId = authAdmin(req) ? (req.query && req.query.sellerId) : null;
        let products;
        if (authSeller(req) && !authAdmin(req)) {
            const user = authUser(req);
            products = db.products.filter(p => p.sellerId === user.id);
        } else {
            products = db.products;
        }
        const stats = { total: products.length, approved: products.filter(p => p.status === 'approved').length, pending: products.filter(p => p.status === 'pending').length, rejected: products.filter(p => p.status === 'rejected').length, totalStock: products.reduce((s, p) => s + (p.stock || 0), 0), totalValue: products.reduce((s, p) => s + (p.price || 0) * (p.stock || 0), 0) };
        return sendJson(res, 200, stats);
    }

    // CART
    if (pathname === '/api/cart' && req.method === 'GET') {
        const user = authUser(req); if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
        const items = db.cart.filter(c => c.userId === user.id).map(c => {
            const prod = db.products.find(p => Number(p.id) === Number(c.productId));
            return prod ? { ...c, product: prod } : null;
        }).filter(Boolean);
        return sendJson(res, 200, items);
    }

    if (pathname === '/api/cart' && req.method === 'POST') {
        const user = authUser(req); if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
        const body = await readJson(req); if (!body) return sendJson(res, 400, { error: 'Invalid JSON' });
        const existing = db.cart.find(c => c.userId === user.id && Number(c.productId) === Number(body.productId));
        if (existing) existing.qty = Math.min(99, existing.qty + 1);
        else db.cart.push({ id: nextId(db.cart), userId: user.id, productId: Number(body.productId), qty: 1 });
        saveDb();
        return sendJson(res, 200, { ok: true });
    }

    if (pathname.match(/^\/api\/cart\/\d+$/) && req.method === 'PUT') {
        const user = authUser(req); if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
        const cartId = Number(pathname.match(/^\/api\/cart\/(\d+)$/)[1]);
        const item = db.cart.find(c => c.id === cartId && c.userId === user.id);
        if (!item) return sendJson(res, 404, { error: 'Cart item not found' });
        const body = await readJson(req); if (!body) return sendJson(res, 400, { error: 'Invalid JSON' });
        item.qty = Math.max(1, Math.min(99, Number(body.qty) || 1));
        saveDb();
        return sendJson(res, 200, { ok: true });
    }

    if (pathname.match(/^\/api\/cart\/\d+$/) && req.method === 'DELETE') {
        const user = authUser(req); if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
        const cartId = Number(pathname.match(/^\/api\/cart\/(\d+)$/)[1]);
        db.cart = db.cart.filter(c => !(c.id === cartId && c.userId === user.id));
        saveDb();
        return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/cart/clear' && req.method === 'POST') {
        const user = authUser(req); if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
        db.cart = db.cart.filter(c => c.userId !== user.id);
        saveDb();
        return sendJson(res, 200, { ok: true });
    }

    // REVIEWS
    if (pathname === '/api/reviews' && req.method === 'GET') {
        const query = new URL(req.url, 'http://localhost:' + PORT).searchParams;
        const productId = Number(query.get('productId'));
        if (!productId) return sendJson(res, 200, db.reviews);
        return sendJson(res, 200, db.reviews.filter(r => Number(r.productId) === productId));
    }

    if (pathname === '/api/reviews' && req.method === 'POST') {
        const user = authUser(req); if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
        const body = await readJson(req); if (!body) return sendJson(res, 400, { error: 'Invalid JSON' });
        const rating = Math.max(1, Math.min(5, Number(body.rating) || 5));
        const review = { id: nextId(db.reviews), userId: user.id, productId: Number(body.productId), rating, text: sanitize(body.text || ''), createdAt: Date.now() };
        db.reviews.push(review);
        const prod = db.products.find(p => Number(p.id) === Number(body.productId));
        if (prod) {
            prod.rating = db.reviews.filter(r => Number(r.productId) === prod.id).reduce((s, r) => s + r.rating, 0) / db.reviews.filter(r => Number(r.productId) === prod.id).length;
            prod.reviewCount = db.reviews.filter(r => Number(r.productId) === prod.id).length;
        }
        const seller = db.sellers.find(s => s.userId === prod && prod.sellerId);
        saveDb();
        return sendJson(res, 201, review);
    }

    // CHECKOUT
    if (pathname === '/api/checkout' && req.method === 'POST') {
        const user = authUser(req); if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
        const body = await readJson(req); if (!body) return sendJson(res, 400, { error: 'Invalid JSON' });
        const items = body.items;
        if (!items || !items.length) return sendJson(res, 400, { error: 'No items in cart' });
        const verified = [];
        for (const item of items) {
            const prod = db.products.find(p => Number(p.id) === Number(item.productId));
            if (!prod || prod.status !== 'approved') return sendJson(res, 400, { error: `Product "${prod ? prod.name : item.productId}" is not available` });
            const qty = Math.max(1, Math.min(Number(item.qty) || 1, 99));
            const stock = prod.stock || 0;
            if (qty > stock) return sendJson(res, 409, { error: `Insufficient stock for "${prod.name}"` });
            prod.stock = stock - qty;
            verified.push({ productId: prod.id, sellerId: prod.sellerId, name: prod.name, price: prod.price, qty, image: prod.images[0] || prod.image, condition: prod.condition });
        }
        const subtotal = verified.reduce((s, i) => s + i.price * i.qty, 0);
        const orderId = 'ORD' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
        const phone = sanitize(body.phone || '');
        const order = { id: orderId, userId: user.id, items: verified, subtotal, total: subtotal, status: 'pending_payment', paymentStatus: 'pending', address: sanitize(body.address || ''), phone, createdAt: Date.now() };
        db.orders.push(order);
        const orderItems = verified.map(item => ({ id: nextId(db.orderItems), orderId: order.id, productId: item.productId, sellerId: item.sellerId, userId: user.id, quantity: item.qty, price: item.price, createdAt: Date.now() }));
        db.orderItems.push(...orderItems);
        db.cart = db.cart.filter(c => c.userId !== user.id);
        saveDb();
        let stkResult = null;
        let paymentInitiated = false;
        if (MPESA_CONSUMER_KEY && MPESA_CONSUMER_SECRET && phone) {
            try {
                stkResult = await initiateStkPush(phone, subtotal, orderId, orderId);
                if (stkResult && stkResult.ResponseCode === '0') {
                    paymentInitiated = true;
                    order.paymentStatus = 'processing';
                    order.stkRequestID = stkResult.MerchantRequestID;
                    order.stkCheckoutRequestID = stkResult.CheckoutRequestID;
                    const payment = { id: nextId(db.payments), orderId, userId: user.id, amount: subtotal, phone: maskPhone(phone), method: 'M-Pesa', status: 'processing', stkRequestID: stkResult.MerchantRequestID, createdAt: Date.now() };
                    db.payments.push(payment);
                    saveDb();
                }
            } catch (e) {
                console.log('STK push failed:', e.message);
                order.paymentStatus = 'pending';
            }
        }
        return sendJson(res, 201, { order, paymentInitiated, stkMessage: paymentInitiated ? 'Check your phone for the M-Pesa payment prompt' : (MPESA_CONSUMER_KEY ? 'Payment prompt failed. Please retry.' : 'Payment not configured. Contact admin.') });
    }

    // PAYMENT CALLBACK (M-Pesa STK push result)
    if (pathname === '/api/pay/callback' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        await new Promise(r => req.on('end', r));
        let callbackData;
        try { callbackData = JSON.parse(body); } catch (e) { return sendJson(res, 200, { ResultCode: 0, ResultDesc: 'OK' }); }
        const stkCallback = callbackData.Body && callbackData.Body.stkCallback;
        if (!stkCallback) return sendJson(res, 200, { ResultCode: 0, ResultDesc: 'OK' });
        const merchantRequestID = stkCallback.MerchantRequestID;
        const resultCode = stkCallback.ResultCode;
        const resultDesc = stkCallback.ResultDesc || '';
        const payment = db.payments.find(p => p.stkRequestID === merchantRequestID);
        if (payment) {
            payment.status = resultCode === 0 ? 'completed' : 'failed';
            payment.resultCode = resultCode;
            payment.resultDesc = resultDesc;
            payment.completedAt = Date.now();
            const order = db.orders.find(o => o.id === payment.orderId);
            if (order) {
                if (resultCode === 0) {
                    order.status = 'confirmed';
                    order.paymentStatus = 'confirmed';
                    order.paidAt = Date.now();
                    order.paymentMethod = 'M-Pesa';
                } else {
                    order.status = 'payment_failed';
                    order.paymentStatus = 'failed';
                    order.paymentError = resultDesc;
                    for (const item of order.items) {
                        const prod = db.products.find(p => Number(p.id) === Number(item.productId));
                        if (prod) prod.stock = (prod.stock || 0) + item.qty;
                    }
                }
            }
            saveDb();
        }
        return sendJson(res, 200, { ResultCode: 0, ResultDesc: 'OK' });
    }

    // PAYMENT STATUS CHECK
    if (pathname.match(/^\/api\/pay\/status\/([\w-]+)$/) && req.method === 'GET') {
        const user = authUser(req); if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
        const orderId = pathname.match(/^\/api\/pay\/status\/([\w-]+)$/)[1];
        const order = db.orders.find(o => o.id === orderId);
        if (!order) return sendJson(res, 404, { error: 'Order not found' });
        if (order.userId !== user.id && user.role !== 'admin') return sendJson(res, 403, { error: 'Access denied' });
        const payment = db.payments.find(p => p.orderId === orderId);
        return sendJson(res, 200, { orderId: order.id, status: order.status, paymentStatus: order.paymentStatus, paymentError: order.paymentError || null, paidAt: order.paidAt || null, payment: payment || null });
    }

    // PAYMENT RETRY
    if (pathname.match(/^\/api\/pay\/retry\/([\w-]+)$/) && req.method === 'POST') {
        const user = authUser(req); if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
        const orderId = pathname.match(/^\/api\/pay\/retry\/([\w-]+)$/)[1];
        const order = db.orders.find(o => o.id === orderId);
        if (!order) return sendJson(res, 404, { error: 'Order not found' });
        if (order.userId !== user.id) return sendJson(res, 403, { error: 'Access denied' });
        if (order.paymentStatus !== 'failed' && order.status !== 'payment_failed') return sendJson(res, 400, { error: 'Order does not need payment retry' });
        if (!order.phone) return sendJson(res, 400, { error: 'No phone number on this order' });
        order.status = 'pending_payment';
        order.paymentStatus = 'pending';
        delete order.paymentError;
        try {
            const stkResult = await initiateStkPush(order.phone, order.total, order.id, order.id);
            if (stkResult && stkResult.ResponseCode === '0') {
                order.paymentStatus = 'processing';
                order.stkRequestID = stkResult.MerchantRequestID;
                order.stkCheckoutRequestID = stkResult.CheckoutRequestID;
                const payment = { id: nextId(db.payments), orderId: order.id, userId: user.id, amount: order.total, phone: maskPhone(order.phone), method: 'M-Pesa', status: 'processing', stkRequestID: stkResult.MerchantRequestID, createdAt: Date.now() };
                db.payments.push(payment);
                saveDb();
                return sendJson(res, 200, { ok: true, message: 'Check your phone for the M-Pesa payment prompt' });
            }
            saveDb();
            return sendJson(res, 500, { error: 'Failed to initiate payment. Please try again.' });
        } catch (e) {
            saveDb();
            return sendJson(res, 500, { error: 'Payment service unavailable. Please try again later.' });
        }
    }

    // ADMIN - Payments list
    if (pathname === '/api/admin/payments' && req.method === 'GET') {
        if (!authAdmin(req)) return sendJson(res, 401, { error: 'Admin access required' });
        return sendJson(res, 200, db.payments.slice().reverse());
    }

    // ORDERS
    if (pathname === '/api/orders' && req.method === 'GET') {
        const user = authUser(req); if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
        if (user.role === 'admin') {
            const orders = db.orders.slice().reverse();
            return sendJson(res, 200, orders);
        }
        const orders = db.orders.filter(o => o.userId === user.id).slice().reverse();
        return sendJson(res, 200, orders);
    }

    if (pathname.match(/^\/api\/orders\/([\w-]+)$/) && req.method === 'GET') {
        const user = authUser(req); if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
        const code = pathname.match(/^\/api\/orders\/([\w-]+)$/)[1];
        const order = db.orders.find(o => o.id === code);
        if (!order) return sendJson(res, 404, { error: 'Order not found' });
        if (user.role !== 'admin' && order.userId !== user.id) {
            const sellerItems = order.items.filter(i => {
                const seller = db.sellers.find(s => s.userId === user.id);
                return seller && i.sellerId === seller.id;
            });
            if (!sellerItems.length) return sendJson(res, 403, { error: 'Access denied' });
        }
        return sendJson(res, 200, order);
    }

    if (pathname.match(/^\/api\/orders\/([\w-]+)\/status$/) && req.method === 'PUT') {
        const user = authSeller(req); if (!user) return sendJson(res, 401, { error: 'Seller access required' });
        const code = pathname.match(/^\/api\/orders\/([\w-]+)\/status$/)[1];
        const order = db.orders.find(o => o.id === code);
        if (!order) return sendJson(res, 404, { error: 'Order not found' });
        const body = await readJson(req); if (!body) return sendJson(res, 400, { error: 'Invalid JSON' });
        const newStatus = sanitize(body.status);
        if (!STATUS_LABEL[newStatus]) return sendJson(res, 400, { error: 'Invalid status' });
        const sellerItems = order.items.filter(i => {
            const seller = db.sellers.find(s => s.userId === user.id);
            return seller && i.sellerId === seller.id;
        });
        if (!sellerItems.length && user.role !== 'admin') return sendJson(res, 403, { error: 'Cannot update this order' });
        order.status = newStatus;
        saveDb();
        return sendJson(res, 200, { ok: true, order });
    }

    if (pathname === '/api/orders/seller' && req.method === 'GET') {
        const user = authSeller(req); if (!user) return sendJson(res, 401, { error: 'Seller access required' });
        const orders = db.orders.filter(o => o.items.some(i => i.sellerId === user.id)).slice().reverse();
        return sendJson(res, 200, orders);
    }

    // ADMIN - Users
    if (pathname === '/api/admin/users' && req.method === 'GET') {
        if (!authAdmin(req)) return sendJson(res, 401, { error: 'Admin access required' });
        return sendJson(res, 200, db.users.map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role, createdAt: u.createdAt })));
    }

    if (pathname === '/api/admin/sellers' && req.method === 'GET') {
        if (!authAdmin(req)) return sendJson(res, 401, { error: 'Admin access required' });
        return sendJson(res, 200, db.sellers.map(s => ({ id: s.id, userId: s.userId, storeName: s.storeName, description: s.description, profileImage: s.profileImage, rating: s.rating, reviewCount: s.reviewCount, isActive: s.isActive, isApproved: s.isApproved, createdAt: s.createdAt })));
    }

    if (pathname.match(/^\/api\/admin\/sellers\/(\d+)\/(approve|reject|suspend|activate)$/) && req.method === 'PUT') {
        if (!authAdmin(req)) return sendJson(res, 401, { error: 'Admin access required' });
        const sellerId = Number(pathname.match(/^\/api\/admin\/sellers\/(\d+)\/(approve|reject|suspend|activate)$/)[1]);
        const action = pathname.match(/^\/api\/admin\/sellers\/(\d+)\/(approve|reject|suspend|activate)$/)[2];
        const seller = db.sellers.find(s => s.id === sellerId);
        if (!seller) return sendJson(res, 404, { error: 'Seller not found' });
        if (action === 'approve') seller.isApproved = true;
        else if (action === 'reject') seller.isApproved = false;
        else if (action === 'suspend') seller.isActive = false;
        else if (action === 'activate') seller.isActive = true;
        saveDb();
        return sendJson(res, 200, { ok: true, seller });
    }

    // ADMIN - Stats
    if (pathname === '/api/admin/stats' && req.method === 'GET') {
        if (!authAdmin(req)) return sendJson(res, 401, { error: 'Admin access required' });
        const totalRevenue = db.orders.reduce((s, o) => s + (o.total || 0), 0);
        const totalOrders = db.orders.length;
        const totalUsers = db.users.length;
        const totalSellers = db.sellers.length;
        const totalProducts = db.products.length;
        const pendingOrders = db.orders.filter(o => o.status === 'pending' || !o.status).length;
        const deliveredOrders = db.orders.filter(o => o.status === 'delivered').length;
        return sendJson(res, 200, { totalRevenue, totalOrders, totalUsers, totalSellers, totalProducts, pendingOrders, deliveredOrders, totalReviews: db.reviews.length, totalCartItems: db.cart.length });
    }

    // UPLOADS (any auth user)
    if (pathname === '/api/upload' && req.method === 'POST') {
        const user = authUser(req); if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
        const rawName = (req.headers['x-filename'] || 'image.jpg').toString().split(/[\\/]/).pop().toLowerCase();
        const ext = path.extname(rawName) || '.jpg';
        if (!['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) return sendJson(res, 400, { error: 'Only image files allowed' });
        const buf = await readBody(req);
        if (!buf || buf.length === 0) return sendJson(res, 400, { error: 'Empty upload' });
        if (buf.length > 5 * 1024 * 1024) return sendJson(res, 400, { error: 'Image must be under 5 MB' });
        const B = buf;
        const magicOk = ((ext === '.jpg' || ext === '.jpeg') && B.length > 3 && B[0] === 0xFF && B[1] === 0xD8 && B[2] === 0xFF) || (ext === '.png' && B.length > 8 && B[0] === 0x89 && B[1] === 0x50 && B[2] === 0x4E && B[3] === 0x47) || (ext === '.gif' && B.length > 6 && B[0] === 0x47 && B[1] === 0x49 && B[2] === 0x46 && B[3] === 0x38) || (ext === '.webp' && B.length > 12 && B[0] === 0x52 && B[1] === 0x49 && B[2] === 0x46 && B[8] === 0x57 && B[9] === 0x45 && B[10] === 0x42 && B[11] === 0x50);
        if (!magicOk) return sendJson(res, 400, { error: 'File contents do not match the image type' });
        const filename = Date.now() + '-' + crypto.randomBytes(4).toString('hex') + ext;
        fs.writeFileSync(path.join(UPLOAD_DIR, filename), buf);
        saveDb();
        return sendJson(res, 201, { url: '/uploads/' + filename });
    }

    // COUPONS
    if (pathname === '/api/coupons' && req.method === 'GET') {
        if (!authAdmin(req)) return sendJson(res, 401, { error: 'Admin access required' });
        return sendJson(res, 200, db.coupons);
    }
    if (pathname === '/api/coupons' && req.method === 'POST') {
        if (!authAdmin(req)) return sendJson(res, 401, { error: 'Admin access required' });
        const body = await readJson(req); if (!body) return sendJson(res, 400, { error: 'Invalid JSON' });
        const code = sanitize(body.code).toUpperCase();
        const percent = Math.max(1, Math.min(90, Number(body.percent) || 10));
        if (!code) return sendJson(res, 400, { error: 'Coupon code required' });
        if (db.coupons.some(c => c.code === code)) return sendJson(res, 409, { error: 'Coupon already exists' });
        const coupon = { id: nextId(db.coupons), code, percent, active: true, createdAt: Date.now() };
        db.coupons.push(coupon);
        saveDb();
        return sendJson(res, 201, coupon);
    }
    if (pathname.match(/^\/api\/coupons\/(\d+)$/) && req.method === 'PUT') {
        if (!authAdmin(req)) return sendJson(res, 401, { error: 'Admin access required' });
        const cid = Number(pathname.match(/^\/api\/coupons\/(\d+)$/)[1]);
        const coupon = db.coupons.find(c => c.id === cid);
        if (!coupon) return sendJson(res, 404, { error: 'Coupon not found' });
        coupon.active = !coupon.active;
        saveDb();
        return sendJson(res, 200, { ok: true, coupon });
    }
    if (pathname.match(/^\/api\/coupons\/(\d+)$/) && req.method === 'DELETE') {
        if (!authAdmin(req)) return sendJson(res, 401, { error: 'Admin access required' });
        const cid = Number(pathname.match(/^\/api\/coupons\/(\d+)$/)[1]);
        db.coupons = db.coupons.filter(c => c.id !== cid);
        saveDb();
        return sendJson(res, 200, { ok: true });
    }
    if (pathname === '/api/coupons/validate' && req.method === 'POST') {
        const body = await readJson(req); if (!body) return sendJson(res, 400, { error: 'Invalid JSON' });
        const code = sanitize(body.code).toUpperCase();
        const coupon = db.coupons.find(c => c.code === code && c.active);
        if (!coupon) return sendJson(res, 404, { error: 'Invalid or expired coupon' });
        return sendJson(res, 200, { code: coupon.code, percent: coupon.percent });
    }

    // STATIC
    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Unknown API endpoint' });

    let filePath = pathname === '/' ? path.join(ROOT, 'index.html') : path.normalize(path.join(ROOT, pathname));
    if (!filePath.startsWith(ROOT)) return sendText(res, 403, 'Forbidden');
    fs.readFile(filePath, (err, content) => {
        if (err) return sendText(res, 404, 'Not found');
        const ext = path.extname(filePath).toLowerCase();
        const isUpload = filePath.startsWith(path.join(ROOT, 'uploads'));
        const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
        if (isUpload) { headers['X-Content-Type-Options'] = 'nosniff'; headers['Content-Disposition'] = 'inline'; }
        else Object.assign(headers, { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdnjs.cloudflare.com; font-src 'self' data: https://cdnjs.cloudflare.com; base-uri 'self'; form-action 'self'" });
        res.writeHead(200, headers); res.end(content);
    });
});

function sendText(res, code, text) { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(text); }
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8' };

function httpsRequest(url, options, body) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const reqOptions = { hostname: urlObj.hostname, port: urlObj.port || 443, path: urlObj.pathname + urlObj.search, method: options.method || 'POST', headers: options.headers || {} };
        const req = https.request(reqOptions, res => { let data = ''; res.on('data', chunk => data += chunk); res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(data) }); } catch (e) { resolve({ status: res.statusCode, data }); } }); });
        req.on('error', reject);
        if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
    });
}

async function getMpesaToken() {
    if (mpesaAccessToken && Date.now() < mpesaTokenExpiry) return mpesaAccessToken;
    if (!MPESA_CONSUMER_KEY || !MPESA_CONSUMER_SECRET) throw new Error('M-Pesa credentials not configured');
    const auth = Buffer.from(MPESA_CONSUMER_KEY + ':' + MPESA_CONSUMER_SECRET).toString('base64');
    const res = await httpsRequest(MPESA_BASE_URL + '/oauth/v1/generate?grant_type=client_credentials', { method: 'GET', headers: { 'Authorization': 'Basic ' + auth } });
    if (res.data && res.data.access_token) {
        mpesaAccessToken = res.data.access_token;
        mpesaTokenExpiry = Date.now() + ((res.data.expires_in || 3599) * 1000) - 60000;
        return mpesaAccessToken;
    }
    throw new Error('Failed to get M-Pesa token');
}

function generateMpesaPassword() {
    const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, '').substring(0, 14);
    const data = MPESA_SHORTCODE + MPESA_PASSKEY + timestamp;
    return { password: Buffer.from(data).toString('base64'), timestamp };
}

async function initiateStkPush(phoneNumber, amount, orderId, accountRef) {
    const token = await getMpesaToken();
    const { password, timestamp } = generateMpesaPassword();
    const phone = phoneNumber.replace(/^0/, '254').replace(/^\+?254/, '254');
    const body = {
        BusinessShortCode: MPESA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerBuyGoodsOnline',
        Amount: Math.round(amount),
        PartyA: phone,
        PartyB: MPESA_SHORTCODE,
        PhoneNumber: phone,
        CallBackURL: MPESA_CALLBACK_URL || 'https://httpbin.org/post',
        AccountReference: accountRef || orderId,
        TransactionDesc: 'Payment for order ' + orderId
    };
    const res = await httpsRequest(MPESA_BASE_URL + '/mpesa/stkpush/v1/processrequest', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
    }, body);
    return res.data;
}

function maskPhone(p) { p = String(p || ''); return p.length <= 4 ? p : p.slice(0, 4) + '****' + p.slice(-2); }
function maskName(n) { n = String(n || ''); const parts = n.trim().split(/\s+/); return parts.length === 0 ? '' : parts[0] + (parts.length > 1 ? ' ' + parts[1].charAt(0) + '.' : ''); }
const HOUR = 3600000;
const STATUS_ORDER = ['processing', 'packed', 'shipped', 'delivered'];
const PAYMENT_STATUSES = ['pending_payment', 'processing_payment', 'confirmed', 'payment_failed', 'cancelled', 'refunded'];
const STATUS_ORDER_PAYMENT = ['processing', 'packed', 'shipped', 'delivered'];
loadDb();
server.listen(PORT, '0.0.0.0', () => { console.log('Abumira marketplace server running at http://0.0.0.0:' + PORT); });
