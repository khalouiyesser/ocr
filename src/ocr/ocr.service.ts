import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import * as Tesseract from 'tesseract.js';
import * as sharp from 'sharp';
import { UpdateOcrDto } from './dto/update-ocr.dto';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Address {
  nom: string | null;
  adresse: string | null;
  ville: string | null;
  code_postal: string | null;
  email: string | null;
  telephone: string | null;
  siret: string | null;
}

interface Article {
  description: string;
  quantite: number | null;
  unite: string | null;
  prix_unitaire_ht: number | null;
  tva_pct: number | null;
  total_ht: number | null;
  total_tva: number | null;
  total_ttc: number | null;
  _validated?: boolean;
  _ocr_warning?: string;
}

interface InvoiceResult {
  vendeur: Address | null;
  client: Address | null;
  date_facturation: string | null;
  date_echeance: string | null;
  numero_facture: string | null;
  conditions_paiement: string | null;
  reference_commande: string | null;
  informations_additionnelles: string | null;
  articles: Article[];
  totaux: {
    total_ht: number | null;
    total_tva: number | null;
    total_ttc: number | null;
  };
  meta: {
    confidence: number;
    rawText: string;
    warnings: string[];
  };
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class OcrService {
  private readonly logger = new Logger(OcrService.name);

  // ═══════════════════════════════════════════════════════════════════════════
  // POINT D'ENTRÉE
  // ═══════════════════════════════════════════════════════════════════════════

  async processInvoice(file: Express.Multer.File): Promise<InvoiceResult> {
    if (!file?.buffer) {
      throw new InternalServerErrorException('Fichier vide ou manquant');
    }

    try {
      // 1. Pré-traitement adaptatif de l'image
      const processedBuffer = await this.preprocessImage(file.buffer);

      // 2. OCR avec Tesseract (haute précision)
      const result = await Tesseract.recognize(processedBuffer, 'fra+eng', {
        logger: (m) => {
          if (m.status === 'recognizing text') {
            this.logger.log(`OCR: ${Math.round(m.progress * 100)}%`);
          }
        },
        // PSM 6 = bloc de texte uniforme → meilleur pour factures
        tessedit_pageseg_mode: '6',
        // OEM 1 = LSTM uniquement (plus précis que legacy)
        tessedit_ocr_engine_mode: '1',
        // Conserver tous les caractères utiles pour une facture française
        tessedit_char_whitelist:
          'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz' +
          'ÀÂÄÉÈÊËÎÏÔÙÛÜÇàâäéèêëîïôùûüç0123456789.,/:€%()+-= @\'"#\n',
        // Préserver la mise en page des tableaux
        preserve_interword_spaces: '1',
      } as any);

      const confidence = result.data.confidence;
      this.logger.log(`OCR confidence: ${confidence.toFixed(1)}%`);

      // 3. Alerter si la confiance est trop basse
      const warnings: string[] = [];
      if (confidence < 70) {
        warnings.push(
          `Confiance OCR faible (${confidence.toFixed(
            1,
          )}%) — résultats à vérifier manuellement`,
        );
      }

      const text = result.data.text;
      return this.extractInvoiceDetails(text, confidence, warnings);
    } catch (err) {
      this.logger.error('OCR processing error', err?.stack);
      throw new InternalServerErrorException('Erreur lors du traitement OCR');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PREPROCESSING IMAGE (Sharp)
  // ═══════════════════════════════════════════════════════════════════════════

  private async preprocessImage(buffer: Buffer): Promise<Buffer> {
    const metadata = await sharp(buffer).metadata();
    const isHighRes = (metadata.width ?? 0) >= 2000;

    return sharp(buffer)
      .rotate()
      .resize({
        width: isHighRes ? 1240 : 1748, // ✅ Moitié moins → 4x plus rapide
        withoutEnlargement: false,
        fit: 'inside',
      })
      .grayscale()
      .normalise({ lower: 1, upper: 99 })
      .median(1)
      .sharpen({ sigma: 1.2, m1: 0.5, m2: 3 })
      .threshold(140)
      .png({ compressionLevel: 0, adaptiveFiltering: false })
      .toBuffer();
  }
  // ═══════════════════════════════════════════════════════════════════════════
  // CORRECTION DU BRUIT OCR
  // ═══════════════════════════════════════════════════════════════════════════

  private fixOcrNoise(text: string): string {
    return (
      text
        // ── Corrections chiffres ──
        .replace(/([0-9])C\b/g, '$10') // 5C → 50
        .replace(/\bC([0-9])/g, '0$1') // C5 → 05
        .replace(/\bC\b/g, '0') // C isolé → 0
        .replace(/\bl\b(?=\s*\d)/g, '1') // l avant chiffre → 1
        .replace(/\bO\b(?=\s*\d)/g, '0') // O avant chiffre → 0
        .replace(/\bë\b/g, '5')
        .replace(/\bq\b(?=\s*\d)/g, '9') // q avant chiffre → 9
        .replace(/\bI\b(?=\s*\d)/g, '1') // I avant chiffre → 1
        .replace(/(?<=\d)\s*,\s*(?=\d{2}\b)/g, ',') // normaliser "1 234 , 56" → "1 234,56"
        // ── Corrections lettres ──
        .replace(/!/g, 'i')
        // ── Nettoyage ponctuation parasite ──
        .replace(/[|]{1}/g, 'I') // | → I (tableaux)
        .replace(/\f/g, '\n') // form feed → newline
        .replace(/\r\n/g, '\n') // CRLF → LF
        .replace(/[ \t]{3,}/g, '  ') // 3+ espaces → 2 espaces (conserver la séparation colonnes)
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EXTRACTION PRINCIPALE
  // ═══════════════════════════════════════════════════════════════════════════

  private extractInvoiceDetails(
    text: string,
    confidence: number,
    warnings: string[],
  ): InvoiceResult {
    const cleanText = text.replace(/\n{3,}/g, '\n\n').trim();
    const fixedText = this.fixOcrNoise(cleanText);

    return {
      vendeur: this.extractParty(fixedText, 'vendeur'),
      client: this.extractParty(fixedText, 'client'),
      ...this.extractMetadata(fixedText),
      informations_additionnelles: this.extractInfosAdditionnelles(cleanText),
      articles: this.extractArticles(fixedText),
      totaux: this.extractTotaux(fixedText),
      meta: {
        confidence,
        rawText: cleanText,
        warnings,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EXTRACTION VENDEUR / CLIENT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Extraction générique d'une partie (vendeur ou client).
   * Gère : nom, adresse, code postal + ville, email, téléphone, SIRET.
   */
  private extractParty(
    text: string,
    type: 'vendeur' | 'client',
  ): Address | null {
    // Délimiter le bloc selon le type
    const blockPatterns: Record<string, RegExp> = {
      vendeur:
        /Vendeur\s*[:\n]?\s*([\s\S]*?)(?=\n(?:Client|Acheteur|Destinataire)\b)/i,
      client:
        /(?:Client|Acheteur|Destinataire)\s*[:\n]?\s*([\s\S]*?)(?=\n(?:Date|N°|Numéro|Référence|Facture)\b)/i,
    };

    const blockMatch = text.match(blockPatterns[type]);
    if (!blockMatch) return null;

    const block = blockMatch[1].trim();
    const lines = block
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) return null;

    // ── Extraction structurée dans le bloc ──
    const emailMatch = block.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i);
    const phoneMatch = block.match(
      /(?:Tél?\.?|Tel|Phone|📞)?\s*((?:\+33|0)[1-9](?:[\s.-]?\d{2}){4})/i,
    );
    const siretMatch = block.match(
      /(?:SIRET|SIREN)\s*[:\s]?\s*(\d[\d\s]{12,14}\d)/i,
    );
    const postalMatch = block.match(/(\d{5})\s+([A-ZÀ-Ü][a-zà-ü\s-]+)/);

    // ── Nettoyage du nom ──
    const cleanName = (s: string) =>
      s
        .replace(/!/g, 'i')
        .replace(/^\d+\.\s*/, '')
        .trim();

    // La première ligne non-métadonnée = nom
    const nomLine = lines.find(
      (l) => !l.match(/\d{5}/) && !l.match(/@/) && !l.match(/SIRET/i),
    );

    // Ligne adresse = contient un numéro de rue
    const adresseLine = lines.find((l) =>
      l.match(/^\d+[,\s]|(?:rue|avenue|bd|chemin|allée|impasse)/i),
    );

    return {
      nom: nomLine ? cleanName(nomLine) : null,
      adresse: adresseLine ?? lines[1] ?? null,
      code_postal: postalMatch ? postalMatch[1] : null,
      ville: postalMatch ? postalMatch[2].trim() : null,
      email: emailMatch ? emailMatch[0] : null,
      telephone: phoneMatch ? phoneMatch[1].replace(/[\s.-]/g, '') : null,
      siret: siretMatch ? siretMatch[1].replace(/\s/g, '') : null,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EXTRACTION MÉTADONNÉES FACTURE
  // ═══════════════════════════════════════════════════════════════════════════

  private extractMetadata(text: string): {
    date_facturation: string | null;
    date_echeance: string | null;
    numero_facture: string | null;
    conditions_paiement: string | null;
    reference_commande: string | null;
  } {
    // ── Numéro de facture ──
    const numMatch = text.match(
      /(?:Facture\s*N[°o]?|N°\s*Facture|Invoice\s*#?)\s*[:\s]?\s*([A-Z0-9][\w/-]{2,20})/i,
    );

    // ── Dates (formats FR et ISO) ──
    const dateRegex = /(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})/g;
    const allDates: string[] = [];
    let dm: RegExpExecArray | null;
    while ((dm = dateRegex.exec(text)) !== null) {
      allDates.push(dm[1]);
    }

    // Date de facturation : première date trouvée (ou label explicite)
    const dateFactMatch = text.match(
      /(?:Date\s*(?:de\s*)?(?:facturation|facture|émission))\s*[:\s]?\s*(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})/i,
    );
    const dateEchMatch = text.match(
      /(?:Date\s*(?:d['']\s*)?(?:échéance|paiement|règlement))\s*[:\s]?\s*(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})/i,
    );

    // ── Conditions de paiement ──
    const condMatch = text.match(
      /(?:Conditions?\s*(?:de\s*)?paiement|Délai\s*(?:de\s*)?paiement)\s*[:\s]?\s*([^\n]{3,50})/i,
    );

    // ── Référence commande ──
    const refMatch = text.match(
      /(?:Référence|Commande|Bon\s*(?:de\s*)?commande|BC)\s*[:\s]?\s*([A-Z0-9][\w/-]{2,20})/i,
    );

    return {
      date_facturation: dateFactMatch ? dateFactMatch[1] : allDates[0] ?? null,
      date_echeance: dateEchMatch ? dateEchMatch[1] : allDates[1] ?? null,
      numero_facture: numMatch ? numMatch[1] : null,
      conditions_paiement: condMatch ? condMatch[1].trim() : null,
      reference_commande: refMatch ? refMatch[1] : null,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EXTRACTION TOTAUX
  // ═══════════════════════════════════════════════════════════════════════════

  private extractTotaux(text: string): {
    total_ht: number | null;
    total_tva: number | null;
    total_ttc: number | null;
  } {
    const montantRx = (label: string) =>
      new RegExp(`${label}\\s*[:|]?\\s*(\\d[\\d\\s]*[.,]\\d{2})\\s*€?`, 'i');

    const htMatch = text.match(montantRx('Total\\s*H\\.?T\\.?'));
    const tvaMatch = text.match(montantRx('(?:Total\\s*)?TVA'));
    const ttcMatch = text.match(
      montantRx('(?:Total\\s*)?(?:TTC|Net\\s*à\\s*payer|Montant\\s*total)'),
    );

    return {
      total_ht: htMatch ? this.parseMontant(htMatch[1]) : null,
      total_tva: tvaMatch ? this.parseMontant(tvaMatch[1]) : null,
      total_ttc: ttcMatch ? this.parseMontant(ttcMatch[1]) : null,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EXTRACTION ARTICLES (Stratégie positionnelle améliorée)
  // ═══════════════════════════════════════════════════════════════════════════

  private extractArticles(text: string): Article[] {
    // Localiser le tableau entre l'en-tête et les totaux
    const tableBlock = text.match(
      /(?:Description|Désignation|Libellé|Prestation)[\s\S]*?(?=(?:Total\s*H\.?T\.?|Sous-total|Montant\s*HT))/i,
    );
    if (!tableBlock) return [];

    const lines = tableBlock[0]
      .split('\n')
      .slice(1) // sauter la ligne d'en-tête
      .map((l) => l.trim())
      .filter((l) => l.length > 3 && !this.isHeaderLine(l));

    const articles: Article[] = [];

    for (const line of lines) {
      const parsed = this.parseArticleLine(line);
      if (parsed) articles.push(parsed);
    }

    // Fusion des lignes de continuation (description sur plusieurs lignes)
    return this.mergeMultilineArticles(articles);
  }

  /**
   * Détecte si une ligne est un en-tête de colonne à ignorer.
   */
  private isHeaderLine(line: string): boolean {
    return /^(?:Description|Désignation|Qté?|Quantité|Prix\s*HT|TVA|Total|Montant|Unité)/i.test(
      line,
    );
  }

  /**
   * Parse une seule ligne de tableau en article structuré.
   */
  private parseArticleLine(line: string): Article | null {
    // Extraire tous les montants (ex: "1 350,00" ou "350.00")
    const montantPattern = /\d[\d\s]*[.,]\d{2}/g;
    const montants: number[] = [];
    let m: RegExpExecArray | null;
    const lineNoEuro = line.replace(/€/g, '');
    while ((m = montantPattern.exec(lineNoEuro)) !== null) {
      montants.push(this.parseMontant(m[0]));
    }

    // Extraire le % TVA
    const tvaMatch = line.match(/(\d{1,3})\s*%/);
    const tva_pct = tvaMatch ? parseInt(tvaMatch[1], 10) : null;

    // Extraire l'unité (h, m², kg, u, pièce, forfait...)
    const uniteMatch = line.match(
      /\b(h(?:eure)?s?|m[²2]|kg|u(?:nité)?s?|pièces?|forfait|jours?|mois)\b/i,
    );
    const unite = uniteMatch ? uniteMatch[1].toLowerCase() : null;

    // Extraire la quantité : premier entier isolé après la description
    const qteMatch = line.match(
      /^[\w\s'\-œæ\/(),.]+?\s{2,}(\d{1,5}(?:[.,]\d{1,3})?)\b/i,
    );
    const quantite = qteMatch
      ? parseFloat(qteMatch[1].replace(',', '.'))
      : null;

    // Extraire la description : tout avant le premier double-espace + chiffre
    const descMatch = line.match(
      /^([\w\s'\-œæ\/(),.éèêëàâùûüîïôçÉÈÊÀÂÙÛÜÎÏÔÇ]+?)(?=\s{2,}\d)/i,
    );
    const description = descMatch ? descMatch[1].trim() : null;

    if (!description || description.length < 2) return null;

    // Attribution positionnelle des montants (de droite à gauche)
    // Ordre attendu : prix_ht, total_ht_ligne, total_tva_ligne, total_ttc_ligne
    const total_ttc =
      montants.length >= 1 ? montants[montants.length - 1] : null;
    const total_tva =
      montants.length >= 2 ? montants[montants.length - 2] : null;
    const total_ht =
      montants.length >= 3 ? montants[montants.length - 3] : null;
    const prix_ht = montants.length >= 4 ? montants[montants.length - 4] : null;

    const validation =
      total_ttc && tva_pct && (prix_ht ?? total_ht) && quantite
        ? this.validateArticle(
            quantite,
            prix_ht ?? total_ht!,
            tva_pct,
            total_tva,
            total_ttc,
          )
        : {
            _ocr_warning:
              'Valeurs partiellement extraites — vérification recommandée',
          };

    return {
      description,
      quantite,
      unite,
      prix_unitaire_ht: prix_ht,
      tva_pct,
      total_ht,
      total_tva,
      total_ttc,
      ...validation,
    };
  }

  /**
   * Fusionne les articles dont la description déborde sur plusieurs lignes.
   * Heuristique : ligne sans montants → continuation de la description précédente.
   */
  private mergeMultilineArticles(articles: Article[]): Article[] {
    const merged: Article[] = [];

    for (const article of articles) {
      const last = merged[merged.length - 1];
      const isContinuation =
        last &&
        article.quantite === null &&
        article.prix_unitaire_ht === null &&
        article.total_ttc === null;

      if (isContinuation) {
        last.description += ' ' + article.description;
      } else {
        merged.push({ ...article });
      }
    }

    return merged;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // VALIDATION CROISÉE D'UN ARTICLE
  // ═══════════════════════════════════════════════════════════════════════════

  private validateArticle(
    quantite: number,
    prix_ht: number,
    tva_pct: number,
    total_tva: number | null,
    total_ttc: number,
  ): { _validated: boolean } | { _ocr_warning: string } {
    const base = quantite * prix_ht;
    const expectedTtc = Math.round(base * (1 + tva_pct / 100) * 100) / 100;
    const expectedTva = Math.round(base * (tva_pct / 100) * 100) / 100;
    const diffTtc = Math.abs(expectedTtc - total_ttc);
    const diffTva = total_tva ? Math.abs(expectedTva - total_tva) : 0;

    if (diffTtc > 1 || diffTva > 1) {
      return {
        _ocr_warning:
          `Incohérence : ${quantite} × ${prix_ht} × (1+${tva_pct}%) ` +
          `= ${expectedTtc} (attendu) ≠ ${total_ttc} (extrait)`,
      };
    }
    return { _validated: true };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INFORMATIONS ADDITIONNELLES
  // ═══════════════════════════════════════════════════════════════════════════

  private extractInfosAdditionnelles(text: string): string | null {
    const match = text.match(
      /Informations?\s+additionnelles?\s*[:\n]\s*([\s\S]*?)(?=\n\n|\nDescription|\nMention|\nSignature|$)/i,
    );
    return match ? match[1].trim() : null;
  }

  /**
   * Convertit "1 350,00" ou "1350.00" en nombre flottant.
   */
  private parseMontant(raw: string): number {
    return parseFloat(raw.trim().replace(/\s/g, '').replace(',', '.'));
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