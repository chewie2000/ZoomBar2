import React from 'react'
import ReactDOM from 'react-dom/client'
import { SigmaClientProvider, client } from '@sigmacomputing/plugin'
import App from './App.jsx'

ReactDOM.createRoot(document.getElementById('root')).render(
  <SigmaClientProvider client={client}>
    <App />
  </SigmaClientProvider>,
)
