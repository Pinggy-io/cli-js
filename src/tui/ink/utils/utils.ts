export function getStatusColor(status: string): string {

    const match = status.match(/\b(\d{3})\b/);
    const statusCode = match ? parseInt(match[1], 10) : 0;


    switch (true) {
        case statusCode >= 100 && statusCode < 200:
            return "yellow";
        case statusCode >= 200 && statusCode < 300:
            return "green";
        case statusCode >= 300 && statusCode < 400:
            return "yellow";
        case statusCode >= 400 && statusCode < 500:
            return "red";
        case statusCode >= 500:
            return "pink";
        default:
            return "yellow";
    }
}

export function getBytesInt(b: number): string {
    if (b >= 1024 * 1024 * 1024) {
        return `${(b / (1024 * 1024 * 1024)).toFixed(2)} G`;
    }
    if (b >= 1024 * 1024) {
        return `${(b / (1024 * 1024)).toFixed(2)} M`;
    }
    if (b >= 1024) {
        return `${(b / 1024).toFixed(2)} K`;
    }
    return `${b.toFixed(2)}  `;
}

