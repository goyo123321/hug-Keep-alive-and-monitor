# hug-Keep-alive-and-monitor
部署方式
复制_worker.js代码
修改https部分改成自己要保活的连接
例如
首页部分

```{ link: 'https://zzrlqdvm-rnaizspw.hf.space/sub', label: '节点信息', highlight: true },```

自动访问保活部分
```{
      id: 'hug-node',
      name: '抱脸项目地址',
      method: 'GET',
      target: 'https://自动访问地址',
      tooltip: 'My production server monitor',
      statusPageLink: 'https://面板访问地址',
      timeout: 10000,
    },```
用Workers或Pages上传cf部署
