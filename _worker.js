// 配置部分
const pageConfig = {
  title: "监控面板",
  description: "实时监控您的所有服务状态",
  links: [
    { link: 'https://blog.xo.je/?i=1', label: '博客', highlight: true },
    { link: 'https://抱脸用户名-抱脸项目名.hf.space/sub', label: '订阅链接', highlight: true }, 
  ],
  footerText: `© ${new Date().getFullYear()} 监控面板 v2.0 | 基于 Cloudflare Workers 构建`,
}

const workerConfig = {
  kvWriteCooldownMinutes: 3,
  // 自动访问配置
  autoVisit: {
    enabled: true,
    intervalMinutes: 5,
    lastRunKey: 'auto_visit_last_run',
    resultsKey: 'auto_visit_results',
    maxResults: 100,
  },
  monitors: [
    {
      id: 'hug',
      name: '抱脸项目一',
      method: 'GET',
      target: 'https://抱脸用户名-抱脸项目名.hf.space/',
      tooltip: 'My production server monitor',
      statusPageLink: 'https://抱脸用户名-抱脸项目名.hf.space/',
      timeout: 10000,
    },
    {
      id: 'hug2',
      name: '抱脸项目二',
      method: 'GET',
      target: 'https://抱脸用户名-抱脸项目名.hf.space/',
      tooltip: 'My production server monitor',
      statusPageLink: 'https://抱脸用户名-抱脸项目名.hf.space/',
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
      return this.handleStatusPage(request, env);
    }

    // API端点 - 获取所有监控状态
    if (path === '/api/status') {
      return this.handleApiStatus(request, env);
    }

    // API端点 - 检查单个监控
    if (path.startsWith('/api/check/')) {
      const monitorId = path.split('/').pop();
      return this.handleCheckMonitor(request, monitorId, env);
    }

    // 手动触发自动访问
    if (path === '/api/auto-visit') {
      const auth = request.headers.get('Authorization');
      if (!auth || auth !== `Bearer ${env.API_KEY}`) {
        return new Response('Unauthorized', { status: 401 });
      }
      return this.handleAutoVisit(request, env, ctx);
    }

    // 查看自动访问历史
    if (path === '/api/auto-visit/history') {
      return this.handleAutoVisitHistory(request, env);
    }

    // 自动访问执行端点（由调度器调用）
    if (path === '/cron/auto-visit') {
      const cronKey = url.searchParams.get('key');
      if (!cronKey || cronKey !== env.CRON_KEY) {
        return new Response('Unauthorized', { status: 401 });
      }
      return this.handleCronAutoVisit(request, env, ctx);
    }

    return new Response('Not Found', { status: 404 });
  },

  // 调度器处理（每小时执行）
  async scheduled(event, env, ctx) {
    ctx.waitUntil(this.executeAutoVisit(env));
  },

  async executeAutoVisit(env) {
    try {
      const now = new Date();
      const lastRunTime = await env.KV_NAMESPACE?.get(workerConfig.autoVisit.lastRunKey);
      
      // 检查冷却时间
      if (lastRunTime) {
        const lastRun = new Date(lastRunTime);
        const minutesSinceLastRun = (now - lastRun) / (1000 * 60);
        
        if (minutesSinceLastRun < workerConfig.autoVisit.intervalMinutes) {
          console.log(`自动访问跳过，距离上次运行仅 ${Math.round(minutesSinceLastRun)} 分钟`);
          return;
        }
      }

      console.log('开始执行自动访问...');
      const results = await this.performAutoVisit(env);
      
      // 保存运行时间和结果
      await env.KV_NAMESPACE?.put(workerConfig.autoVisit.lastRunKey, now.toISOString());
      
      // 保存结果到历史记录
      const historyEntry = {
        timestamp: now.toISOString(),
        results: results,
        summary: {
          total: results.length,
          success: results.filter(r => r.status === 'up').length,
          failed: results.filter(r => r.status === 'down').length
        }
      };
      
      await this.saveAutoVisitResult(env, historyEntry);
      
      console.log(`自动访问完成: ${historyEntry.summary.success}/${historyEntry.summary.total} 成功`);
      
    } catch (error) {
      console.error('自动访问执行失败:', error);
    }
  },

  async performAutoVisit(env) {
    const results = [];
    
    // 并行执行所有监控检查（限制并发数）
    const concurrency = 3; // 同时检查3个，避免过多并发请求
    const monitors = [...workerConfig.monitors];
    
    for (let i = 0; i < monitors.length; i += concurrency) {
      const batch = monitors.slice(i, i + concurrency);
      const batchPromises = batch.map(monitor => 
        this.checkMonitorWithRetry(monitor, 2) // 重试2次
      );
      
      const batchResults = await Promise.allSettled(batchPromises);
      
      batchResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          const monitor = batch[index];
          results.push({
            id: monitor.id,
            name: monitor.name,
            status: 'down',
            error: result.reason.message,
            lastChecked: new Date().toISOString(),
            target: monitor.target,
            retries: 2
          });
        }
      });
      
      // 批次之间延迟1秒，避免对目标服务器造成过大压力
      if (i + concurrency < monitors.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    return results;
  },

  async checkMonitorWithRetry(monitor, maxRetries) {
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.checkMonitor(monitor);
        if (result.status === 'up') {
          return { ...result, retries: attempt - 1 };
        }
        lastError = result.error;
        
        // 如果不是最后一次尝试，等待后重试
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); // 指数退避
        }
      } catch (error) {
        lastError = error.message;
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
      }
    }
    
    return {
      id: monitor.id,
      name: monitor.name,
      status: 'down',
      error: lastError || 'Max retries exceeded',
      lastChecked: new Date().toISOString(),
      target: monitor.target,
      retries: maxRetries
    };
  },

  async saveAutoVisitResult(env, result) {
    if (!env.KV_NAMESPACE) return;
    
    try {
      // 获取现有历史记录
      const existingHistory = await env.KV_NAMESPACE.get(workerConfig.autoVisit.resultsKey);
      let history = existingHistory ? JSON.parse(existingHistory) : [];
      
      // 添加新结果
      history.unshift(result);
      
      // 限制历史记录数量
      if (history.length > workerConfig.autoVisit.maxResults) {
        history = history.slice(0, workerConfig.autoVisit.maxResults);
      }
      
      // 保存回KV
      await env.KV_NAMESPACE.put(workerConfig.autoVisit.resultsKey, JSON.stringify(history));
      
    } catch (error) {
      console.error('保存自动访问结果失败:', error);
    }
  },

  async handleStatusPage(request, env) {
    // 实时检查所有监控状态
    const statusData = await this.getAllMonitorStatus();
    
    // 获取自动访问历史
    let autoVisitHistory = [];
    if (env.KV_NAMESPACE) {
      try {
        const historyData = await env.KV_NAMESPACE.get(workerConfig.autoVisit.resultsKey);
        autoVisitHistory = historyData ? JSON.parse(historyData) : [];
      } catch (error) {
        console.error('获取自动访问历史失败:', error);
      }
    }

    const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${pageConfig.title} - 实时监控面板</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        :root {
            --primary: #4361ee;
            --primary-light: #4895ef;
            --secondary: #3a0ca3;
            --success: #4cc9f0;
            --success-dark: #2ec4b6;
            --danger: #f72585;
            --warning: #f8961e;
            --dark: #212529;
            --light: #f8f9fa;
            --gray: #6c757d;
            --gray-light: #e9ecef;
            --card-bg: rgba(255, 255, 255, 0.95);
            --shadow: 0 10px 30px rgba(0, 0, 0, 0.08);
            --shadow-hover: 0 15px 40px rgba(0, 0, 0, 0.12);
            --radius: 16px;
            --transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            --gradient-primary: linear-gradient(135deg, #4361ee, #3a0ca3);
            --gradient-success: linear-gradient(135deg, #4cc9f0, #2ec4b6);
            --gradient-danger: linear-gradient(135deg, #f72585, #b5179e);
            --gradient-warning: linear-gradient(135deg, #f8961e, #f3722c);
        }
        
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #f5f7fa 0%, #e4e8f0 100%);
            color: var(--dark);
            min-height: 100vh;
            line-height: 1.6;
            padding: 20px;
        }
        
        .container {
            max-width: 1400px;
            margin: 0 auto;
        }
        
        /* 头部样式 */
        .header {
            background: var(--card-bg);
            backdrop-filter: blur(10px);
            border-radius: var(--radius);
            padding: 30px;
            margin-bottom: 30px;
            box-shadow: var(--shadow);
            border: 1px solid rgba(255, 255, 255, 0.2);
            position: relative;
            overflow: hidden;
        }
        
        .header::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 4px;
            background: var(--gradient-primary);
        }
        
        .header-content {
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-wrap: wrap;
            gap: 20px;
        }
        
        .title-section h1 {
            font-size: 2.2rem;
            font-weight: 800;
            background: var(--gradient-primary);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 8px;
        }
        
        .title-section p {
            color: var(--gray);
            font-size: 1rem;
        }
        
        .links {
            display: flex;
            gap: 12px;
            flex-wrap: wrap;
        }
        
        .link-btn {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 12px 24px;
            background: var(--gradient-primary);
            color: white;
            text-decoration: none;
            border-radius: 50px;
            font-weight: 600;
            font-size: 0.95rem;
            transition: var(--transition);
            box-shadow: 0 4px 15px rgba(67, 97, 238, 0.3);
        }
        
        .link-btn:hover {
            transform: translateY(-3px);
            box-shadow: 0 8px 25px rgba(67, 97, 238, 0.4);
        }
        
        .link-btn.highlight {
            background: var(--gradient-success);
            box-shadow: 0 4px 15px rgba(44, 196, 182, 0.3);
        }
        
        .link-btn.highlight:hover {
            box-shadow: 0 8px 25px rgba(44, 196, 182, 0.4);
        }
        
        /* 统计卡片 */
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        
        .stat-card {
            background: var(--card-bg);
            border-radius: var(--radius);
            padding: 25px;
            box-shadow: var(--shadow);
            border: 1px solid rgba(255, 255, 255, 0.2);
            transition: var(--transition);
            text-align: center;
            cursor: pointer;
        }
        
        .stat-card:hover {
            transform: translateY(-5px);
            box-shadow: var(--shadow-hover);
        }
        
        .stat-card.total {
            border-top: 4px solid var(--primary);
        }
        
        .stat-card.up {
            border-top: 4px solid var(--success-dark);
        }
        
        .stat-card.down {
            border-top: 4px solid var(--danger);
        }
        
        .stat-icon {
            width: 60px;
            height: 60px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 15px;
            font-size: 24px;
        }
        
        .stat-card.total .stat-icon {
            background: linear-gradient(135deg, rgba(67, 97, 238, 0.1), rgba(58, 12, 163, 0.1));
            color: var(--primary);
        }
        
        .stat-card.up .stat-icon {
            background: linear-gradient(135deg, rgba(76, 201, 240, 0.1), rgba(46, 196, 182, 0.1));
            color: var(--success-dark);
        }
        
        .stat-card.down .stat-icon {
            background: linear-gradient(135deg, rgba(247, 37, 133, 0.1), rgba(181, 23, 158, 0.1));
            color: var(--danger);
        }
        
        .stat-value {
            font-size: 2.5rem;
            font-weight: 800;
            margin-bottom: 5px;
        }
        
        .stat-card.total .stat-value {
            color: var(--primary);
        }
        
        .stat-card.up .stat-value {
            color: var(--success-dark);
        }
        
        .stat-card.down .stat-value {
            color: var(--danger);
        }
        
        .stat-label {
            color: var(--gray);
            font-size: 0.95rem;
            font-weight: 500;
        }
        
        /* 自动访问控制 */
        .auto-visit-card {
            background: var(--card-bg);
            border-radius: var(--radius);
            padding: 25px;
            margin-bottom: 30px;
            box-shadow: var(--shadow);
            border: 1px solid rgba(255, 255, 255, 0.2);
            position: relative;
            overflow: hidden;
        }
        
        .auto-visit-card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            width: 4px;
            height: 100%;
            background: var(--gradient-warning);
        }
        
        .auto-visit-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            flex-wrap: wrap;
            gap: 15px;
        }
        
        .auto-visit-title {
            display: flex;
            align-items: center;
            gap: 12px;
        }
        
        .auto-visit-title i {
            font-size: 1.5rem;
            color: var(--warning);
            background: linear-gradient(135deg, rgba(248, 150, 30, 0.1), rgba(243, 114, 44, 0.1));
            width: 50px;
            height: 50px;
            border-radius: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        
        .auto-visit-title h2 {
            font-size: 1.5rem;
            font-weight: 700;
        }
        
        .auto-visit-title p {
            color: var(--gray);
            font-size: 0.9rem;
            margin-top: 4px;
        }
        
        .auto-visit-controls {
            display: flex;
            gap: 12px;
            flex-wrap: wrap;
        }
        
        .btn {
            padding: 12px 24px;
            border: none;
            border-radius: 50px;
            font-weight: 600;
            font-size: 0.95rem;
            cursor: pointer;
            transition: var(--transition);
            display: inline-flex;
            align-items: center;
            gap: 8px;
        }
        
        .btn-primary {
            background: var(--gradient-primary);
            color: white;
            box-shadow: 0 4px 15px rgba(67, 97, 238, 0.3);
        }
        
        .btn-primary:hover {
            transform: translateY(-3px);
            box-shadow: 0 8px 25px rgba(67, 97, 238, 0.4);
        }
        
        .btn-success {
            background: var(--gradient-success);
            color: white;
            box-shadow: 0 4px 15px rgba(44, 196, 182, 0.3);
        }
        
        .btn-success:hover {
            transform: translateY(-3px);
            box-shadow: 0 8px 25px rgba(44, 196, 182, 0.4);
        }
        
        .btn-outline {
            background: transparent;
            color: var(--primary);
            border: 2px solid var(--primary);
        }
        
        .btn-outline:hover {
            background: rgba(67, 97, 238, 0.1);
        }
        
        /* 历史记录 */
        .history-section {
            margin-top: 25px;
            border-top: 1px solid var(--gray-light);
            padding-top: 25px;
            display: none;
        }
        
        .history-section.show {
            display: block;
            animation: fadeIn 0.5s ease;
        }
        
        .history-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
            gap: 15px;
            margin-top: 15px;
        }
        
        .history-item {
            background: rgba(248, 249, 250, 0.8);
            border-radius: 12px;
            padding: 18px;
            border-left: 4px solid var(--primary-light);
            transition: var(--transition);
        }
        
        .history-item:hover {
            transform: translateY(-3px);
            box-shadow: 0 5px 15px rgba(0, 0, 0, 0.05);
        }
        
        .history-time {
            font-weight: 600;
            margin-bottom: 8px;
            color: var(--dark);
        }
        
        .history-stats {
            display: flex;
            gap: 15px;
            font-size: 0.9rem;
        }
        
        .stat-success {
            color: var(--success-dark);
            font-weight: 600;
        }
        
        .stat-failed {
            color: var(--danger);
            font-weight: 600;
        }
        
        .stat-total {
            color: var(--gray);
        }
        
        /* 监控卡片网格 */
        .monitor-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        
        .monitor-card {
            background: var(--card-bg);
            border-radius: var(--radius);
            padding: 25px;
            box-shadow: var(--shadow);
            border: 1px solid rgba(255, 255, 255, 0.2);
            transition: var(--transition);
            position: relative;
            overflow: hidden;
        }
        
        .monitor-card:hover {
            transform: translateY(-5px);
            box-shadow: var(--shadow-hover);
        }
        
        .monitor-card.status-up {
            border-top: 4px solid var(--success-dark);
        }
        
        .monitor-card.status-down {
            border-top: 4px solid var(--danger);
        }
        
        .monitor-card.status-unknown {
            border-top: 4px solid var(--warning);
        }
        
        .status-badge {
            position: absolute;
            top: 20px;
            right: 20px;
            padding: 6px 16px;
            border-radius: 50px;
            font-size: 0.8rem;
            font-weight: 700;
            letter-spacing: 0.5px;
            text-transform: uppercase;
        }
        
        .status-up .status-badge {
            background: rgba(44, 196, 182, 0.1);
            color: var(--success-dark);
        }
        
        .status-down .status-badge {
            background: rgba(247, 37, 133, 0.1);
            color: var(--danger);
        }
        
        .status-unknown .status-badge {
            background: rgba(248, 150, 30, 0.1);
            color: var(--warning);
        }
        
        .monitor-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            margin-bottom: 20px;
        }
        
        .monitor-name {
            flex: 1;
            margin-right: 15px;
        }
        
        .monitor-name h3 {
            font-size: 1.2rem;
            font-weight: 700;
            margin-bottom: 5px;
            color: var(--dark);
        }
        
        .monitor-name a {
            color: inherit;
            text-decoration: none;
            transition: var(--transition);
        }
        
        .monitor-name a:hover {
            color: var(--primary);
        }
        
        .monitor-id {
            color: var(--gray);
            font-size: 0.85rem;
            font-family: 'Monaco', 'Courier New', monospace;
            margin-top: 5px;
        }
        
        .monitor-details {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 15px;
            margin-bottom: 20px;
        }
        
        .detail-item {
            background: rgba(248, 249, 250, 0.8);
            border-radius: 12px;
            padding: 15px;
        }
        
        .detail-label {
            font-size: 0.8rem;
            color: var(--gray);
            margin-bottom: 5px;
            font-weight: 500;
        }
        
        .detail-value {
            font-size: 1.2rem;
            font-weight: 700;
            color: var(--dark);
        }
        
        .response-time {
            color: var(--success-dark);
        }
        
        .status-code {
            color: var(--primary);
        }
        
        .monitor-error {
            background: rgba(247, 37, 133, 0.05);
            border-left: 4px solid var(--danger);
            padding: 12px 15px;
            border-radius: 8px;
            margin-top: 15px;
            font-size: 0.9rem;
        }
        
        .error-label {
            color: var(--danger);
            font-weight: 600;
            margin-bottom: 5px;
            display: flex;
            align-items: center;
            gap: 5px;
        }
        
        .last-checked {
            font-size: 0.85rem;
            color: var(--gray);
            margin-top: 20px;
            text-align: center;
            padding-top: 15px;
            border-top: 1px solid var(--gray-light);
        }
        
        /* 页脚 */
        .footer {
            text-align: center;
            padding: 25px;
            color: var(--gray);
            font-size: 0.9rem;
            background: var(--card-bg);
            border-radius: var(--radius);
            box-shadow: var(--shadow);
            margin-top: 30px;
        }
        
        .refresh-info {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-top: 15px;
            padding-top: 15px;
            border-top: 1px solid var(--gray-light);
        }
        
        /* 加载动画 */
        .loading-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.7);
            display: flex;
            justify-content: center;
            align-items: center;
            z-index: 9999;
            display: none;
            backdrop-filter: blur(5px);
        }
        
        .loading-content {
            background: var(--card-bg);
            border-radius: var(--radius);
            padding: 40px;
            text-align: center;
            max-width: 400px;
            width: 90%;
            box-shadow: 0 20px 50px rgba(0, 0, 0, 0.3);
        }
        
        .spinner {
            width: 60px;
            height: 60px;
            border: 5px solid rgba(67, 97, 238, 0.1);
            border-top: 5px solid var(--primary);
            border-radius: 50%;
            margin: 0 auto 20px;
            animation: spin 1s linear infinite;
        }
        
        /* 动画 */
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        
        @keyframes pulse {
            0% { transform: scale(1); }
            50% { transform: scale(1.05); }
            100% { transform: scale(1); }
        }
        
        .pulse {
            animation: pulse 2s infinite;
        }
        
        /* 响应式设计 */
        @media (max-width: 1200px) {
            .monitor-grid {
                grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
            }
        }
        
        @media (max-width: 768px) {
            .header-content {
                flex-direction: column;
                text-align: center;
            }
            
            .links {
                justify-content: center;
            }
            
            .monitor-grid {
                grid-template-columns: 1fr;
            }
            
            .stats-grid {
                grid-template-columns: repeat(2, 1fr);
            }
            
            .auto-visit-header {
                flex-direction: column;
                align-items: flex-start;
            }
            
            .auto-visit-controls {
                width: 100%;
            }
            
            .btn {
                flex: 1;
                justify-content: center;
            }
            
            .refresh-info {
                flex-direction: column;
                gap: 10px;
                text-align: center;
            }
        }
        
        @media (max-width: 480px) {
            .stats-grid {
                grid-template-columns: 1fr;
            }
            
            .monitor-details {
                grid-template-columns: 1fr;
            }
            
            .history-grid {
                grid-template-columns: 1fr;
            }
            
            .title-section h1 {
                font-size: 1.8rem;
            }
        }
        
        /* 暗黑模式 */
        @media (prefers-color-scheme: dark) {
            :root {
                --dark: #f8f9fa;
                --light: #121212;
                --card-bg: rgba(30, 30, 30, 0.95);
                --gray: #adb5bd;
                --gray-light: #343a40;
            }
            
            body {
                background: linear-gradient(135deg, #0d1117 0%, #161b22 100%);
            }
            
            .detail-item, .history-item {
                background: rgba(52, 58, 64, 0.5);
            }
        }
    </style>
</head>
<body>
    <!-- 加载遮罩层 -->
    <div class="loading-overlay" id="loadingOverlay">
        <div class="loading-content">
            <div class="spinner"></div>
            <h3>正在执行自动访问</h3>
            <p>请稍候，这可能需要几秒钟...</p>
        </div>
    </div>
    
    <div class="container">
        <!-- 头部 -->
        <header class="header">
            <div class="header-content">
                <div class="title-section">
                    <h1><i class="fas fa-shield-alt"></i> ${pageConfig.title}</h1>
                    <p>${pageConfig.description} | 最后更新: ${new Date().toLocaleString('zh-CN')}</p>
                </div>
                
                <div class="links">
                    ${pageConfig.links.map(link => `
                        <a href="${link.link}" class="link-btn ${link.highlight ? 'highlight' : ''}" target="_blank">
                            <i class="fas fa-external-link-alt"></i> ${link.label}
                        </a>
                    `).join('')}
                </div>
            </div>
        </header>
        
        <!-- 统计信息 -->
        <div class="stats-grid">
            <div class="stat-card total" onclick="location.reload()">
                <div class="stat-icon">
                    <i class="fas fa-server"></i>
                </div>
                <div class="stat-value" id="total-monitors">${statusData.length}</div>
                <div class="stat-label">总监控服务</div>
            </div>
            
            <div class="stat-card up" onclick="location.reload()">
                <div class="stat-icon">
                    <i class="fas fa-check-circle"></i>
                </div>
                <div class="stat-value" id="up-monitors">${statusData.filter(m => m.status === 'up').length}</div>
                <div class="stat-label">在线服务</div>
            </div>
            
            <div class="stat-card down" onclick="location.reload()">
                <div class="stat-icon">
                    <i class="fas fa-exclamation-triangle"></i>
                </div>
                <div class="stat-value" id="down-monitors">${statusData.filter(m => m.status === 'down').length}</div>
                <div class="stat-label">异常服务</div>
            </div>
        </div>
        
        <!-- 自动访问控制 -->
        <div class="auto-visit-card">
            <div class="auto-visit-header">
                <div class="auto-visit-title">
                    <i class="fas fa-robot pulse"></i>
                    <div>
                        <h2>自动访问系统</h2>
                        <p>定期自动检查服务状态，保持服务活跃</p>
                    </div>
                </div>
                
                <div class="auto-visit-controls">
                    <button class="btn btn-success" onclick="triggerAutoVisit()">
                        <i class="fas fa-play-circle"></i> 立即执行
                    </button>
                    <button class="btn btn-outline" onclick="toggleHistory()">
                        <i class="fas fa-history"></i> 查看历史
                    </button>
                </div>
            </div>
            
            <!-- 历史记录 -->
            <div class="history-section" id="historySection">
                <h3><i class="fas fa-chart-line"></i> 执行历史记录</h3>
                <div class="history-grid" id="historyList">
                    ${autoVisitHistory.length > 0 ? autoVisitHistory.map((entry, index) => `
                        <div class="history-item">
                            <div class="history-time">
                                <i class="far fa-clock"></i> ${new Date(entry.timestamp).toLocaleString('zh-CN')}
                                ${index === 0 ? '<span style="margin-left:8px;background:#4361ee;color:white;padding:2px 8px;border-radius:10px;font-size:0.7rem;">最新</span>' : ''}
                            </div>
                            <div class="history-stats">
                                <span class="stat-success"><i class="fas fa-check"></i> ${entry.summary.success} 成功</span>
                                <span class="stat-failed"><i class="fas fa-times"></i> ${entry.summary.failed} 失败</span>
                                <span class="stat-total"><i class="fas fa-chart-bar"></i> ${entry.summary.total} 总计</span>
                            </div>
                        </div>
                    `).join('') : '<p style="text-align:center;color:var(--gray);padding:20px;">暂无历史记录</p>'}
                </div>
            </div>
        </div>
        
        <!-- 监控卡片网格 -->
        <div class="monitor-grid">
            ${statusData.map(monitor => `
                <div class="monitor-card status-${monitor.status}">
                    <div class="status-badge">
                        ${monitor.status === 'up' ? '在线' : monitor.status === 'down' ? '离线' : '未知'}
                    </div>
                    
                    <div class="monitor-header">
                        <div class="monitor-name">
                            <h3>
                                <a href="${monitor.statusPageLink || monitor.target}" target="_blank">
                                    ${monitor.name}
                                </a>
                            </h3>
                            <div class="monitor-id">
                                <i class="fas fa-hashtag"></i> ${monitor.id}
                            </div>
                        </div>
                    </div>
                    
                    <div class="monitor-details">
                        <div class="detail-item">
                            <div class="detail-label">响应时间</div>
                            <div class="detail-value response-time">${monitor.responseTime ? monitor.responseTime + ' ms' : 'N/A'}</div>
                        </div>
                        
                        <div class="detail-item">
                            <div class="detail-label">状态码</div>
                            <div class="detail-value status-code">${monitor.statusCode || 'N/A'}</div>
                        </div>
                    </div>
                    
                    ${monitor.error ? `
                    <div class="monitor-error">
                        <div class="error-label">
                            <i class="fas fa-exclamation-circle"></i> 错误信息
                        </div>
                        <div>${monitor.error}</div>
                    </div>
                    ` : ''}
                    
                    <div class="last-checked">
                        <i class="far fa-clock"></i> 最后检查: ${new Date(monitor.lastChecked).toLocaleString('zh-CN')}
                    </div>
                </div>
            `).join('')}
        </div>
        
        <!-- 页脚 -->
        <footer class="footer">
            <div class="refresh-info">
                <span><i class="fas fa-sync-alt"></i> 页面每30秒自动刷新</span>
                <span><i class="far fa-calendar-alt"></i> ${new Date().toLocaleString('zh-CN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</span>
            </div>
            <p>${pageConfig.footerText}</p>
        </footer>
    </div>

    <script>
        // 自动访问功能
        async function triggerAutoVisit() {
            const loading = document.getElementById('loadingOverlay');
            loading.style.display = 'flex';
            
            try {
                // 在实际使用中，您需要通过某种方式获取API密钥
                // 这里使用弹窗输入的方式
                const token = prompt('请输入自动访问令牌:');
                if (!token) {
                    alert('令牌不能为空');
                    loading.style.display = 'none';
                    return;
                }
                
                const response = await fetch('/api/auto-visit', {
                    headers: {
                        'Authorization': 'Bearer ' + token
                    }
                });
                
                if (response.ok) {
                    const result = await response.json();
                    alert('✅ 自动访问已触发！\\n\\n执行结果:\\n✓ 成功: ' + result.summary.success + 
                          '\\n✗ 失败: ' + result.summary.failed + 
                          '\\n📊 总计: ' + result.summary.total);
                    
                    // 3秒后刷新页面显示最新状态
                    setTimeout(() => location.reload(), 3000);
                } else {
                    alert('❌ 触发失败: ' + (await response.text()));
                }
            } catch (error) {
                alert('❌ 请求失败: ' + error.message);
            } finally {
                loading.style.display = 'none';
            }
        }
        
        function toggleHistory() {
            const section = document.getElementById('historySection');
            section.classList.toggle('show');
            
            // 滚动到历史记录部分
            if (section.classList.contains('show')) {
                section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }
        
        // 每30秒自动刷新状态
        let refreshTimer = setTimeout(() => {
            location.reload();
        }, 30000);
        
        // 添加点击卡片效果
        document.addEventListener('DOMContentLoaded', function() {
            const cards = document.querySelectorAll('.monitor-card');
            cards.forEach(card => {
                card.addEventListener('click', function(e) {
                    if (!e.target.closest('a')) {
                        this.style.transform = 'scale(0.98)';
                        setTimeout(() => {
                            this.style.transform = '';
                        }, 200);
                    }
                });
                
                // 触摸反馈
                card.addEventListener('touchstart', function() {
                    this.style.opacity = '0.8';
                });
                
                card.addEventListener('touchend', function() {
                    this.style.opacity = '1';
                });
            });
            
            // 键盘快捷键
            document.addEventListener('keydown', function(e) {
                if (e.key === 'r' || e.key === 'R') {
                    if (e.ctrlKey || e.metaKey) {
                        e.preventDefault();
                        location.reload();
                    }
                }
                
                if (e.key === 'Escape') {
                    const loading = document.getElementById('loadingOverlay');
                    loading.style.display = 'none';
                }
            });
            
            // 页面可见性变化时重置计时器
            document.addEventListener('visibilitychange', function() {
                if (!document.hidden) {
                    clearTimeout(refreshTimer);
                    refreshTimer = setTimeout(() => {
                        location.reload();
                    }, 30000);
                }
            });
            
            // 添加平滑滚动
            document.querySelectorAll('a[href^="#"]').forEach(anchor => {
                anchor.addEventListener('click', function (e) {
                    e.preventDefault();
                    const targetId = this.getAttribute('href');
                    const targetElement = document.querySelector(targetId);
                    if (targetElement) {
                        targetElement.scrollIntoView({
                            behavior: 'smooth'
                        });
                    }
                });
            });
        });
    </script>
</body>
</html>`;

    return new Response(html, {
      headers: { 
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      },
    });
  },

  async handleApiStatus(request, env) {
    const statusData = await this.getAllMonitorStatus();
    return new Response(JSON.stringify(statusData, null, 2), {
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
    });
  },

  async handleCheckMonitor(request, monitorId, env) {
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

  async handleAutoVisit(request, env, ctx) {
    // 在后台执行自动访问
    ctx.waitUntil(this.performAutoVisit(env).then(async (results) => {
      const summary = {
        total: results.length,
        success: results.filter(r => r.status === 'up').length,
        failed: results.filter(r => r.status === 'down').length
      };
      
      // 保存结果
      const historyEntry = {
        timestamp: new Date().toISOString(),
        results: results,
        summary: summary
      };
      
      await this.saveAutoVisitResult(env, historyEntry);
    }));
    
    return new Response(JSON.stringify({
      message: '自动访问已触发，正在后台执行',
      timestamp: new Date().toISOString()
    }), {
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
    });
  },

  async handleAutoVisitHistory(request, env) {
    if (!env.KV_NAMESPACE) {
      return new Response(JSON.stringify({ error: 'KV not configured' }), {
        status: 500,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
      });
    }
    
    try {
      const historyData = await env.KV_NAMESPACE.get(workerConfig.autoVisit.resultsKey);
      const history = historyData ? JSON.parse(historyData) : [];
      
      return new Response(JSON.stringify(history, null, 2), {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
      });
    }
  },

  async handleCronAutoVisit(request, env, ctx) {
    const results = await this.performAutoVisit(env);
    const summary = {
      total: results.length,
      success: results.filter(r => r.status === 'up').length,
      failed: results.filter(r => r.status === 'down').length
    };
    
    // 保存结果
    const historyEntry = {
      timestamp: new Date().toISOString(),
      results: results,
      summary: summary
    };
    
    await this.saveAutoVisitResult(env, historyEntry);
    
    return new Response(JSON.stringify({
      message: 'Cron自动访问完成',
      summary: summary,
      timestamp: new Date().toISOString()
    }), {
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
