# Sweet Sunday Dashboard Phase 2 Shopify Setup

This dashboard keeps Shopify credentials server-side. Do not paste tokens into `index.html`.

## 1. Create the private env file

Copy `.env.example` to `.env` in this folder:

```bash
cp .env.example .env
```

Then fill in:

```bash
SHOPIFY_SHOP_DOMAIN=sweet-sunday.myshopify.com
SHOPIFY_ADMIN_TOKEN=[PRIVATE_ADMIN_API_TOKEN]
```

## 2. Shopify custom app scopes

For the current Store adapter, use read-only access:

- `read_orders`
- `read_products`
- `read_inventory`

## 3. Run the server

```bash
PORT=8766 node server.mjs
```

## 4. Check connection status

Open:

```text
http://127.0.0.1:8766/api/shopify/status
```

Expected states:

- `mode: mock-fallback` means no private credentials were found yet.
- `mode: live` means Shopify connected.
- `mode: credential-check-failed` means credentials exist but Shopify rejected the check.

## 5. Data shown in Phase 2

Live mode currently powers:

- Store orders
- Average order value
- Low-stock count
- Top products by ordered quantity

Traffic, Email, Social, SEO, Competitors, and Trademarks stay mocked until their own phases.
