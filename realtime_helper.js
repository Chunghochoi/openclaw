const axios = require('axios');

// Định nghĩa Schema báo cho LLM biết hệ thống có tool gì
function getToolsSchema() {
    return[
        {
            type: "function",
            function: {
                name: "search_web",
                description: "Tìm kiếm thông tin cập nhật trên Internet (tin tức, tài liệu, giá cả).",
                parameters: {
                    type: "object",
                    properties: { query: { type: "string", description: "Từ khóa tìm kiếm" } },
                    required: ["query"]
                }
            }
        },
        {
            type: "function",
            function: {
                name: "get_weather",
                description: "Lấy thời tiết hiện tại của một địa điểm",
                parameters: {
                    type: "object",
                    properties: { location: { type: "string", description: "Tên thành phố (ví dụ: Hanoi)" } },
                    required: ["location"]
                }
            }
        }
    ];
}

// Execution engine
async function executeTool(name, args) {
    console.log(`[Tool Use] Calling ${name} with`, args);
    try {
        if (name === 'search_web') {
            // Dùng DuckDuckGo HTML scraper (Free/No-key) hoặc Serper.dev nếu cấu hình key
            // Dưới đây là API Free giả lập hoặc bạn có thể thay bằng API thật
            const res = await axios.get(`https://api.duckduckgo.com/?q=${encodeURIComponent(args.query)}&format=json`, { timeout: 10000 });
            return res.data.AbstractText ? { result: res.data.AbstractText, source: "DuckDuckGo" } : { result: "Không tìm thấy kết quả chính xác, hãy thử query khác.", status: "no_data" };
        }
        
        if (name === 'get_weather') {
            const res = await axios.get(`https://wttr.in/${encodeURIComponent(args.location)}?format=j1`, { timeout: 10000 });
            const current = res.data.current_condition[0];
            return {
                location: args.location,
                temp_C: current.temp_C,
                condition: current.weatherDesc[0].value,
                humidity: current.humidity
            };
        }

        return { error: "Tool không tồn tại" };
    } catch (error) {
        console.error(`[Tool Error] ${name} failed:`, error.message);
        return { error: "Không thể lấy dữ liệu realtime do timeout hoặc lỗi mạng", details: error.message };
    }
}

module.exports = { getToolsSchema, executeTool };
