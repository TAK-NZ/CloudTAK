# Weather Proxy

RainViewer radar tiles proxy service for CloudTAK integration.

## Features

- Proxies RainViewer radar tiles with caching
- Supports multiple color schemes
- Uses most recent radar data automatically
- Built-in caching (10 minutes TTL)
- CORS enabled for web integration
- Health check endpoint

## Quick Start

No API key required - RainViewer is free!

```bash
docker-compose up --build
```

## API Endpoints

- `GET /health` - Health check and cache status
- `GET /colors` - List available color schemes
- `GET /radar/:z/:x/:y.png?color=1` - Radar tile endpoint

## Available Color Schemes

- `0` - Original
- `1` - Universal Blue (default)
- `2` - TITAN
- `3` - The Weather Channel
- `4` - Meteored
- `5` - NEXRAD Level-III
- `6` - RAINBOW @ SELEX-SI
- `7` - Dark Sky

## Usage Examples

```
http://localhost:3001/radar/5/15/12.png
http://localhost:3001/radar/5/15/12.png?color=2
```

## Integration with CloudTAK

Add as tile layer source:
```javascript
map.addSource('weather-radar', {
    type: 'raster',
    tiles: ['http://localhost:3001/radar/{z}/{x}/{y}.png?color=1'],
    tileSize: 256
});
```