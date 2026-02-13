import { Injectable, InternalServerErrorException } from '@nestjs/common';
import * as Tesseract from 'tesseract.js';
import * as sharp from 'sharp';
import { UpdateOcrDto } from './dto/update-ocr.dto';

@Injectable()
export class OcrService {
  async processInvoice(file: Express.Multer.File) {
    if (!file?.buffer) throw new InternalServerErrorException('Fichier vide');

    try {
      const processedBuffer = await this.preprocessImage(file.buffer);

      const result = await Tesseract.recognize(processedBuffer, 'fra', {
        logger: (m) => {
          if (m.status === 'recognizing text') {
            console.log(`OCR progress: ${Math.round(m.progress * 100)}%`);
          }
        },
        tessedit_pageseg_mode: '6',
        tessedit_char_whitelist:
          'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz' +
          "ÀÂÄÉÈÊËÎÏÔÙÛÜÇàâäéèêëîïôùûüç0123456789.,/:€% -@'",
      } as any);

      const text = result.data.text;
      return this.extractInvoiceDetails(text);
    } catch (err) {
      console.error('OCR processing error:', err);
      throw new InternalServerErrorException('Erreur lors du traitement OCR');
    }
  }

  // ─── Preprocessing Sharp ─────────────────────────────────────────────────
  private async preprocessImage(buffer: Buffer): Promise<Buffer> {
    return sharp(buffer)
      .resize({ width: 2480, withoutEnlargement: false })
      .grayscale()
      .normalise()
      .sharpen({ sigma: 1.5 })
      .threshold(150)
      .png({ compressionLevel: 0 })
      .toBuffer();
  }

  // ─── Nettoyage OCR global ─────────────────────────────────────────────────
  private fixOcrNoise(text: string): string {
    return text
      .replace(/([0-9])C\b/g, '$10')
      .replace(/\bC([0-9])/g, '0$1')
      .replace(/\bC\b/g, '0')
      .replace(/\bl\b/g, '1')
      .replace(/\bO\b/g, '0')
      .replace(/\bë\b/g, '5')
      .replace(/\bq\b/g, '9')
      .replace(/!/g, 'i')
      .replace(/\bI\b(?=\s*\d)/g, '1');
  }

  // ─── Extraction des champs ────────────────────────────────────────────────
  private extractInvoiceDetails(text: string) {
    const cleanText = text.replace(/\n{3,}/g, '\n\n').trim();
    const fixedText = this.fixOcrNoise(cleanText);

    const vendeurBlock = cleanText.match(/Vendeur\s+([\s\S]*?)(?=\nClient\b)/i);
    const vendeurLines = vendeurBlock
      ? vendeurBlock[1]
          .trim()
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
      : [];

    const clientBlock = cleanText.match(
      /Client\s+([\s\S]*?)(?=\nDate\s+de\s+facturation)/i,
    );
    const clientLines = clientBlock
      ? clientBlock[1]
          .trim()
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
      : [];

    const cleanName = (s: string) =>
      s
        ?.replace(/!/g, 'i')
        .replace(/^\d+\.\s*/, '')
        .trim() ?? null;

    const metaLine = fixedText.match(
      /(\d{1,2}[.\/\-]\d{1,2}[.\/\-]\d{2,4})\s+(\d+)\s+(\d{1,2}[.\/\-]\d{1,2}[.\/\-]\d{2,4})\s+(\d+\s*jours?)\s+(\d+)/i,
    );

    const montantRegex = (label: string) =>
      new RegExp(`${label}\\s*[:|]?\\s*(\\d[\\d\\s]*[.,]\\d{2})\\s*€?`, 'i');

    const htMatch = fixedText.match(montantRegex('Total\\s*HT'));
    const tvaMatch = fixedText.match(montantRegex('Total\\s*TVA'));
    const ttcMatch = fixedText.match(montantRegex('Total\\s*TTC'));

    const articles = this.extractArticles(fixedText, {
      total_ht: htMatch ? this.parseMontant(htMatch[1]) : null,
      total_tva: tvaMatch ? this.parseMontant(tvaMatch[1]) : null,
      total_ttc: ttcMatch ? this.parseMontant(ttcMatch[1]) : null,
    });

    const infoMatch = cleanText.match(
      /Informations?\s+additionnelles?\s*[:\n]\s*([\s\S]*?)(?=\n\n|\nDescription|\nMain)/i,
    );

    return {
      vendeur: vendeurLines.length
        ? {
            nom: cleanName(vendeurLines[0]),
            adresse: cleanName(vendeurLines[1]) ?? null,
            ville: vendeurLines[2]?.trim() ?? null,
          }
        : null,
      client: clientLines.length
        ? {
            nom: cleanName(clientLines[0]),
            adresse: cleanName(clientLines[1]) ?? null,
            ville: clientLines[2]?.trim() ?? null,
          }
        : null,
      date: metaLine ? metaLine[1] : null,
      numero_facture: metaLine ? metaLine[2] : null,
      echeance: metaLine ? metaLine[3] : null,
      paiement: metaLine ? metaLine[4].trim() : null,
      reference: metaLine ? metaLine[5] : null,
      informations_additionnelles: infoMatch ? infoMatch[1].trim() : null,
      articles,
      totaux: {
        total_ht: htMatch ? this.parseMontant(htMatch[1]) : null,
        total_tva: tvaMatch ? this.parseMontant(tvaMatch[1]) : null,
        total_ttc: ttcMatch ? this.parseMontant(ttcMatch[1]) : null,
      },
      rawText: cleanText,
    };
  }

  // ─── Extraction articles ──────────────────────────────────────────────────
  private extractArticles(
    text: string,
    totaux: {
      total_ht: number | null;
      total_tva: number | null;
      total_ttc: number | null;
    },
  ): any[] {
    const tableBlock = text.match(/Description[\s\S]*?(?=Total\s*HT)/i);
    if (!tableBlock) return [];

    const lines = tableBlock[0]
      .split('\n')
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => l.length > 3);

    const articles: any[] = [];

    for (const line of lines) {
      const montantPattern = /\d[\d\s]*[.,]\d{2}/g;
      const montants: number[] = [];
      let mMatch;
      const lineCopy = line.replace(/€/g, '');
      while ((mMatch = montantPattern.exec(lineCopy)) !== null) {
        montants.push(this.parseMontant(mMatch[0]));
      }

      const tvaMatch = line.match(/(\d{1,3})\s*%/);
      const tva_pct = tvaMatch ? parseInt(tvaMatch[1], 10) : null;

      const qteMatch = line.match(
        /^[\w\s'\-œæ]+?\s{2,}(\d{1,4})\b(?!\s*[.,]\d{2})/i,
      );
      const quantite = qteMatch ? parseInt(qteMatch[1], 10) : null;

      const descMatch = line.match(/^([\w\s'\-œæ,]+?)(?=\s{2,}\d)/i);
      const description = descMatch ? descMatch[1].trim() : null;

      if (!description) continue;

      const total_ttc =
        montants.length >= 1 ? montants[montants.length - 1] : null;
      const total_tva =
        montants.length >= 2 ? montants[montants.length - 2] : null;
      const prix_ht =
        montants.length >= 3 ? montants[montants.length - 3] : null;

      articles.push({
        description,
        quantite,
        prix_unitaire_ht: prix_ht,
        tva_pct,
        total_tva,
        total_ttc,
        ...(total_ttc && tva_pct && prix_ht && quantite
          ? this.validateArticle(
              quantite,
              prix_ht,
              tva_pct,
              total_tva,
              total_ttc,
            )
          : {
              _ocr_warning:
                'Valeurs partiellement extraites — vérification recommandée',
            }),
      });
    }

    return articles;
  }

  // ─── Validation croisée ───────────────────────────────────────────────────
  private validateArticle(
    quantite: number,
    prix_ht: number,
    tva_pct: number,
    total_tva: number | null,
    total_ttc: number,
  ): object {
    const expectedTtc =
      Math.round(quantite * prix_ht * (1 + tva_pct / 100) * 100) / 100;
    const diff = Math.abs(expectedTtc - total_ttc);
    if (diff > 1) {
      return {
        _ocr_warning: `Incohérence probable : ${quantite} × ${prix_ht} × ${
          1 + tva_pct / 100
        } = ${expectedTtc} ≠ ${total_ttc}`,
      };
    }
    return { _validated: true };
  }

  // ─── Utilitaire montant ───────────────────────────────────────────────────
  private parseMontant(raw: string): number {
    return parseFloat(raw.replace(/\s/g, '').replace(',', '.'));
  }

  // ─── CRUD boilerplate ─────────────────────────────────────────────────────
  findAll() {
    return `This action returns all ocr`;
  }
  findOne(id: number) {
    return `This action returns a #${id} ocr`;
  }
  update(id: number, _dto: UpdateOcrDto) {
    return `This action updates a #${id} ocr`;
  }
  remove(id: number) {
    return `This action removes a #${id} ocr`;
  }
}
