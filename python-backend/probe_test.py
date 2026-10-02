import asyncio
import json
import websockets

ENDPOINTS = [
    "wss://ws.derivws.com/websockets/v3?app_id=1089",
    "wss://ws.binaryws.com/websockets/v3?app_id=1089",
    "wss://ws.derivws.com/websockets/v3?app_id=16929",
    "wss://ws.derivws.com/websockets/v3?app_id=36300",
]

HEADERS = {
    "Origin": "https://deriv.com",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
}

async def test_endpoint(url):
    print(f"\n--- Testing {url} ---")
    try:
        async with websockets.connect(url, ssl=True, extra_headers=HEADERS, ping_interval=20, ping_timeout=10) as ws:
            print("Connected! Sending ping...")
            await ws.send(json.dumps({"ping": 1}))
            res = await ws.recv()
            print("Ping response:", res)

            print("Sending ticks_history for frxEURUSD...")
            await ws.send(json.dumps({
                "ticks_history": "frxEURUSD",
                "adjust_start_time": 1,
                "count": 3,
                "end": "latest",
                "granularity": 60,
                "style": "candles"
            }))
            res = await ws.recv()
            print("Candles response:", res[:200])
            return True
    except Exception as e:
        print("Failed:", e)
        return False

async def main():
    for ep in ENDPOINTS:
        success = await test_endpoint(ep)
        if success:
            print(f"\n>>> SUCCESS with {ep} <<<")
            break

if __name__ == "__main__":
    asyncio.run(main())
