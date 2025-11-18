// 配置部分
const pageConfig = {
  title: "自动访问保活和监控",
  links: [
    { link: 'https://zzrlqdvm-rnaizspw.hf.space/sub', label: '节点信息', highlight: true }, 
  ],
}

const workerConfig = {
  kvWriteCooldownMinutes: 3,
  monitors: [
    {
      id: 'hug-node',
      name: '抱脸项目地址',
      method: 'GET',
      target: 'https://自动访问地址',
      tooltip: 'My production server monitor',
      statusPageLink: 'https://面板访问地址',
      timeout: 10000,
    },
    {
      id: '老王',
      name: '老王node-Argo项目地址',
      method: 'GET',
      target: 'https://github.com/eooce/nodejs-argo',
      tooltip: 'My production server monitor',
      statusPageLink: 'https://github.com/eooce/nodejs-argo',
      timeout: 10000,
    },
  ]
}

// Worker主代码
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 状态页面
    if (path === '/' || path === '/status') {
      return this.handleStatusPage(request);
    }

    // API端点 - 获取所有监控状态
    if (path === '/api/status') {
      return this.handleApiStatus(request);
    }

    // API端点 - 检查单个监控
    if (path.startsWith('/api/check/')) {
      const monitorId = path.split('/').pop();
      return this.handleCheckMonitor(request, monitorId);
    }

    return new Response('Not Found', { status: 404 });
  },

  async handleStatusPage(request) {
    // 实时检查所有监控状态
    const statusData = await this.getAllMonitorStatus();
    
    const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${pageConfig.title}</title>
    <style>
        :root {
            --primary-color: #0366d6;
            --success-color: #28a745;
            --danger-color: #dc3545;
            --warning-color: #ffc107;
            --text-color: #333;
            --light-text: #666;
            --lighter-text: #999;
            --bg-color: #f5f5f5;
            --card-bg: white;
            --border-radius: 8px;
            --shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
            color: var(--text-color);
            background-color: var(--bg-color);
            padding: 0;
            margin: 0;
        }
        
        .container {
            width: 100%;
            max-width: 1200px;
            margin: 0 auto;
            padding: 15px;
        }
        
        .header {
            text-align: center;
            margin-bottom: 20px;
            padding: 15px 0;
            background-color: var(--card-bg);
            border-radius: var(--border-radius);
            box-shadow: var(--shadow);
        }
        
        .header h1 {
            font-size: 1.5rem;
            margin-bottom: 15px;
        }
        
        .links {
            display: flex;
            flex-wrap: wrap;
            justify-content: center;
            gap: 10px;
        }
        
        .links a {
            text-decoration: none;
            color: var(--primary-color);
            padding: 8px 12px;
            border-radius: 4px;
            transition: all 0.2s;
            font-size: 0.9rem;
        }
        
        .links a:not(.highlight) {
            border: 1px solid var(--primary-color);
        }
        
        .links a.highlight {
            font-weight: bold;
            color: white;
            background: var(--primary-color);
        }
        
        .links a:hover {
            opacity: 0.8;
        }
        
        .monitor-grid {
            display: grid;
            grid-template-columns: 1fr;
            gap: 15px;
        }
        
        .monitor-card {
            background: var(--card-bg);
            border-radius: var(--border-radius);
            padding: 15px;
            box-shadow: var(--shadow);
            transition: transform 0.2s;
        }
        
        .monitor-card:hover {
            transform: translateY(-2px);
        }
        
        .status-up {
            border-left: 4px solid var(--success-color);
        }
        
        .status-down {
            border-left: 4px solid var(--danger-color);
        }
        
        .status-unknown {
            border-left: 4px solid var(--warning-color);
        }
        
        .monitor-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            margin-bottom: 10px;
        }
        
        .monitor-name {
            font-weight: bold;
            font-size: 1rem;
            flex: 1;
        }
        
        .monitor-name a {
            color: var(--text-color);
            text-decoration: none;
        }
        
        .monitor-name a:hover {
            color: var(--primary-color);
        }
        
        .monitor-status {
            display: inline-block;
            padding: 3px 10px;
            border-radius: 12px;
            font-size: 0.8rem;
            color: white;
            font-weight: bold;
            white-space: nowrap;
            margin-left: 10px;
        }
        
        .status-up .monitor-status { background: var(--success-color); }
        .status-down .monitor-status { background: var(--danger-color); }
        .status-unknown .monitor-status { background: var(--warning-color); }
        
        .monitor-details {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px;
            font-size: 0.85rem;
            color: var(--light-text);
        }
        
        .monitor-detail {
            display: flex;
            flex-direction: column;
        }
        
        .detail-label {
            font-size: 0.75rem;
            color: var(--lighter-text);
            margin-bottom: 2px;
        }
        
        .last-checked {
            font-size: 0.8rem;
            color: var(--lighter-text);
            margin-top: 10px;
            text-align: center;
        }
        
        .footer {
            text-align: center;
            margin-top: 20px;
            padding: 15px;
            color: var(--lighter-text);
            font-size: 0.85rem;
        }
        
        .error-message {
            color: var(--danger-color);
            font-size: 0.8rem;
            margin-top: 5px;
        }
        
        .loading-indicator {
            text-align: center;
            padding: 20px;
            color: var(--light-text);
        }
        
        .refresh-info {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-top: 15px;
            padding-top: 15px;
            border-top: 1px solid #eee;
            font-size: 0.8rem;
            color: var(--lighter-text);
        }
        
        .stats {
            display: flex;
            justify-content: space-around;
            margin-bottom: 20px;
            text-align: center;
        }
        
        .stat-item {
            flex: 1;
            padding: 10px;
            background: var(--card-bg);
            border-radius: var(--border-radius);
            margin: 0 5px;
            box-shadow: var(--shadow);
        }
        
        .stat-value {
            font-size: 1.5rem;
            font-weight: bold;
            margin-bottom: 5px;
        }
        
        .stat-label {
            font-size: 0.8rem;
            color: var(--light-text);
        }
        
        /* 平板和桌面样式 */
        @media (min-width: 768px) {
            .container {
                padding: 20px;
            }
            
            .header h1 {
                font-size: 2rem;
            }
            
            .monitor-grid {
                grid-template-columns: repeat(2, 1fr);
                gap: 20px;
            }
            
            .links a {
                font-size: 1rem;
                padding: 10px 15px;
            }
            
            .monitor-name {
                font-size: 1.1rem;
            }
        }
        
        /* 大屏幕样式 */
        @media (min-width: 1024px) {
            .monitor-grid {
                grid-template-columns: repeat(3, 1fr);
            }
        }
        
        /* 深色模式支持 */
        @media (prefers-color-scheme: dark) {
            :root {
                --text-color: #e1e1e1;
                --light-text: #a1a1a1;
                --lighter-text: #7a7a7a;
                --bg-color: #121212;
                --card-bg: #1e1e1e;
                --shadow: 0 2px 4px rgba(0,0,0,0.3);
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>${pageConfig.title}</h1>
            <div class="links">
                ${pageConfig.links.map(link => 
                    `<a href="${link.link}" class="${link.highlight ? 'highlight' : ''}" target="_blank">${link.label}</a>`
                ).join('')}
            </div>
        </div>
        
        <!-- 统计信息 -->
        <div class="stats">
            <div class="stat-item">
                <div class="stat-value" id="total-monitors">${statusData.length}</div>
                <div class="stat-label">总监控</div>
            </div>
            <div class="stat-item">
                <div class="stat-value" id="up-monitors">${statusData.filter(m => m.status === 'up').length}</div>
                <div class="stat-label">在线</div>
            </div>
            <div class="stat-item">
                <div class="stat-value" id="down-monitors">${statusData.filter(m => m.status === 'down').length}</div>
                <div class="stat-label">离线</div>
            </div>
        </div>
        
        <div class="monitor-grid">
            ${statusData.map(monitor => `
                <div class="monitor-card status-${monitor.status}">
                    <div class="monitor-header">
                        <div class="monitor-name">
                            <a href="${monitor.statusPageLink || monitor.target}" target="_blank">${monitor.name}</a>
                        </div>
                        <div class="monitor-status">${monitor.status === 'up' ? '在线' : monitor.status === 'down' ? '离线' : '未知'}</div>
                    </div>
                    
                    <div class="monitor-details">
                        <div class="monitor-detail">
                            <span class="detail-label">响应时间</span>
                            <span>${monitor.responseTime || 'N/A'}ms</span>
                        </div>
                        <div class="monitor-detail">
                            <span class="detail-label">状态码</span>
                            <span>${monitor.statusCode || 'N/A'}</span>
                        </div>
                    </div>
                    
                    ${monitor.error ? `
                    <div class="error-message">
                        错误: ${monitor.error}
                    </div>
                    ` : ''}
                    
                    <div class="last-checked">
                        最后检查: ${new Date(monitor.lastChecked).toLocaleString('zh-CN')}
                    </div>
                </div>
            `).join('')}
        </div>
        
        <div class="footer">
            <div class="refresh-info">
                <span>页面每30秒自动刷新</span>
                <span>最后更新: ${new Date().toLocaleString('zh-CN')}</span>
            </div>
        </div>
    </div>

    <script>
        // 每30秒自动刷新状态
        setTimeout(() => {
            location.reload();
        }, 30000);
        
        // 添加点击刷新功能
        document.addEventListener('DOMContentLoaded', function() {
            const stats = document.querySelectorAll('.stat-item');
            stats.forEach(stat => {
                stat.addEventListener('click', function() {
                    location.reload();
                });
            });
            
            // 添加触摸反馈
            const cards = document.querySelectorAll('.monitor-card');
            cards.forEach(card => {
                card.addEventListener('touchstart', function() {
                    this.style.opacity = '0.7';
                });
                
                card.addEventListener('touchend', function() {
                    this.style.opacity = '1';
                });
            });
        });
    </script>
</body>
</html>`;

    return new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  },

  async handleApiStatus(request) {
    const statusData = await this.getAllMonitorStatus();
    return new Response(JSON.stringify(statusData, null, 2), {
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
    });
  },

  async handleCheckMonitor(request, monitorId) {
    const monitor = workerConfig.monitors.find(m => m.id === monitorId);
    if (!monitor) {
      return new Response(JSON.stringify({ error: 'Monitor not found' }), {
        status: 404,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
      });
    }

    const result = await this.checkMonitor(monitor);
    return new Response(JSON.stringify(result, null, 2), {
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
    });
  },

  async getAllMonitorStatus() {
    // 并行检查所有监控
    const checkPromises = workerConfig.monitors.map(monitor => 
      this.checkMonitor(monitor)
    );
    
    const results = await Promise.allSettled(checkPromises);
    
    return results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        const monitor = workerConfig.monitors[index];
        return {
          id: monitor.id,
          name: monitor.name,
          status: 'unknown',
          error: result.reason.message,
          lastChecked: new Date().toISOString(),
          target: monitor.target,
          statusPageLink: monitor.statusPageLink
        };
      }
    });
  },

  async checkMonitor(monitor) {
    const startTime = Date.now();
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), monitor.timeout || 10000);

      const response = await fetch(monitor.target, {
        method: monitor.method,
        signal: controller.signal,
        headers: {
          'User-Agent': 'Cloudflare-Workers-Monitor/1.0'
        }
      });

      clearTimeout(timeoutId);

      const responseTime = Date.now() - startTime;
      const isSuccess = response.status < 400;

      return {
        id: monitor.id,
        name: monitor.name,
        status: isSuccess ? 'up' : 'down',
        responseTime: responseTime,
        statusCode: response.status,
        lastChecked: new Date().toISOString(),
        target: monitor.target,
        statusPageLink: monitor.statusPageLink
      };

    } catch (error) {
      return {
        id: monitor.id,
        name: monitor.name,
        status: 'down',
        responseTime: null,
        error: error.message,
        lastChecked: new Date().toISOString(),
        target: monitor.target,
        statusPageLink: monitor.statusPageLink
      };
    }
  }
}

// 导出配置
export { pageConfig, workerConfig };