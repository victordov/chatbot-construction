# Chatbot Widget Integration Guide

This document provides instructions for integrating the chatbot widget into your website.

## Quick Start

Add the following script tag just before the closing `</body>` tag of your HTML:

```html
<script 
    src="https://your-server-url/widget/js/widget-loader.js" 
    data-server-url="https://your-server-url" 
    data-chatbot-name="Your Assistant Name" 
    data-primary-color="#2196f3" 
    data-position="right"
    data-initial-message="Hello! How can I help you today?">
</script>
```

Replace `https://your-server-url` with the actual URL of your chatbot server.

## Configuration Options

The widget can be customized using data attributes on the script tag:

| Attribute | Description | Default |
|-----------|-------------|---------|
| `data-server-url` | The URL of your chatbot server | Required |
| `data-chatbot-name` | The name displayed in the chat header | "Assistant" |
| `data-primary-color` | The main color of the widget (HEX format) | "#2196f3" |
| `data-position` | Position of the widget, either "right" or "left" | "right" |
| `data-initial-message` | The first message displayed by the chatbot | "Hello! How can I assist you today?" |

## Features

### Real-time Chat

The widget provides real-time communication with your chatbot using WebSockets. Users can send messages and receive responses instantly.

### File Uploads

Users can upload PDF documents through the widget. The widget displays a file selection button that allows users to choose files from their device.

### Session Persistence

Chat sessions are maintained across page refreshes and between multiple tabs/windows of the same browser. This allows users to continue their conversation even if they navigate to different pages on your website.

### Typing Indicators

The widget shows when the chatbot is typing, providing a more natural conversation experience.

### Read Receipts

Users can see when their messages have been received and read by the system.

### Responsive Design

The widget is fully responsive and works on all devices, from desktop to mobile.

## Customization

### Styling

The widget's appearance can be customized using the `data-primary-color` attribute to match your website's branding.

### Positioning

The widget can be positioned on either the right or left side of the screen using the `data-position` attribute.

## Security

The widget is designed to communicate securely with your chatbot server. It uses domain whitelisting to prevent unauthorized access.

## Browser Compatibility

The widget is compatible with all modern browsers:

- Chrome (latest)
- Firefox (latest)
- Safari (latest)
- Edge (latest)

Internet Explorer is not supported.

## Troubleshooting

### Widget Not Loading

- Ensure the `data-server-url` is correct and the server is running
- Check browser console for any error messages
- Verify that the domain is whitelisted on the server

### Connection Issues

- Check if the WebSocket connection is being blocked by a firewall
- Ensure the server is properly configured for WebSocket connections

### File Upload Problems

- Verify that the server's file upload endpoint is working correctly
- Check if the file size exceeds the maximum allowed size
- Ensure the file type is supported (currently only PDF files are supported)

## Support

For any issues or questions regarding the widget integration, please contact support at support@yourdomain.com.
