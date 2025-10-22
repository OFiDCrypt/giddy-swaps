// pdfHandler.js: Fetch and extract text from hosted PDF URLs (e.g., GitHub Pages)
import axios from 'axios';
import pdf from 'pdf-parse';

export async function extractPdfText(pdfUrl) {
  try {
    console.log(`📄 Fetching PDF from: ${pdfUrl}`);
    const response = await axios.get(pdfUrl, { responseType: 'arraybuffer' });  // Binary fetch
    const dataBuffer = Buffer.from(response.data, 'binary');
    const pdfData = await pdf(dataBuffer);
    const text = pdfData.text.trim();  // Raw extracted text

    // Optional: Light summary (limit to ~500 chars for prompts)
    const summary = text.length > 500 ? text.substring(0, 500) + '...' : text;

    console.log(`✅ PDF extracted: ${text.length} chars (summary: ${summary.length})`);
    return { fullText: text, summary };  // Return both for flexibility
  } catch (err) {
    console.error(`❌ PDF fetch/parse error for ${pdfUrl}: ${err.message}`);
    return { fullText: '', summary: 'PDF unavailable—check the link! 😅' };
  }
}

// Example usage: Pre-load your PDFs (call in bot startup or on-demand)
export const companyPdfs = {
  whitepaper: 'https://www.ofidcrypt.com/docs/files/doc-whitepaper-micro-v1-0-0.pdf',
  faq: 'https://www.ofidcrypt.com/docs/files/cmc-application-expb-2025-08-27.pdf',
  microeconomies: 'https://www.ofidcrypt.com/docs/files/doc-whitepaper-micro-v1-0-0.pdf',
  listing: 'https://www.ofidcrypt.com/docs/files/cmc-application-expb-2025-08-27.pdf',
  partnership: 'https://www.ofidcrypt.com/docs/files/pa-partner-dobby.pdf',
  press: 'https://www.ofidcrypt.com/docs/files/pr-ofidcrypt-giddys_family-safe-produts_bouncy-ball_microeconomies_edition_396.pdf',
  // Add more: { name: 'url' }
};