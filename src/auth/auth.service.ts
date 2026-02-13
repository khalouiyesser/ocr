import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { v4 as uuidv4 } from 'uuid';
import { nanoid } from 'nanoid';
import * as bcrypt from 'bcryptjs';
import * as Twilio from 'twilio';
import { MailService } from 'src/services/mail.service';
import { RolesService } from 'src/roles/roles.service';
import { Permission } from '../roles/dtos/role.dto';

// ─── Types en mémoire ────────────────────────────────────────────────────────

interface UserRecord {
  _id: string;
  email: string;
  password?: string;
  roleId?: string;
}

interface RefreshTokenRecord {
  token: string;
  userId: string;
  expiryDate: Date;
}

interface ResetTokenRecord {
  token: string;
  userId: string;
  expiryDate: Date;
}

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly twilioClient;

  // ── Stockage en mémoire (remplace MongoDB) ──
  private users: UserRecord[] = [];
  private refreshTokens: RefreshTokenRecord[] = [];
  private resetTokens: ResetTokenRecord[] = [];
  private otpStorage = new Map<string, string>();

  constructor(
    private jwtService: JwtService,
    private mailService: MailService,
    private rolesService: RolesService,
  ) {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    this.twilioClient = Twilio(accountSid, authToken);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AUTH
  // ═══════════════════════════════════════════════════════════════════════════

  async signup(email: string): Promise<UserRecord> {
    const emailInUse = this.users.find((u) => u.email === email);
    if (emailInUse) {
      throw new BadRequestException('Email already in use');
    }

    const newUser: UserRecord = {
      _id: uuidv4(),
      email,
    };
    this.users.push(newUser);
    return newUser;
  }

  async login(email: string) {
    let user = this.users.find((u) => u.email === email);
    if (!user) {
      user = await this.signup(email);
    }

    const tokens = await this.generateUserTokens(user._id);
    return {
      ...tokens,
      userId: user._id,
    };
  }

  async changePassword(
    userId: string,
    oldPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = this.users.find((u) => u._id === userId);
    if (!user) throw new NotFoundException('User not found');

    if (oldPassword && user.password) {
      const isMatch = await bcrypt.compare(oldPassword, user.password);
      if (!isMatch) throw new UnauthorizedException('Old password incorrect');
    }

    user.password = await bcrypt.hash(newPassword, 10);
  }

  async forgotPassword(email: string) {
    const user = this.users.find((u) => u.email === email);

    if (user) {
      const expiryDate = new Date();
      expiryDate.setHours(expiryDate.getHours() + 1);

      const resetToken = nanoid(64);

      // Supprimer les anciens tokens pour cet utilisateur
      this.resetTokens = this.resetTokens.filter((t) => t.userId !== user._id);
      this.resetTokens.push({
        token: resetToken,
        userId: user._id,
        expiryDate,
      });

      this.mailService.sendPasswordResetEmail(email, resetToken);
    }

    return { message: 'If this user exists, they will receive an email' };
  }

  async resetPassword(newPassword: string, resetToken: string): Promise<void> {
    const now = new Date();
    const index = this.resetTokens.findIndex(
      (t) => t.token === resetToken && t.expiryDate >= now,
    );

    if (index === -1) throw new UnauthorizedException('Invalid link');

    const { userId } = this.resetTokens[index];
    this.resetTokens.splice(index, 1); // supprimer le token utilisé

    const user = this.users.find((u) => u._id === userId);
    if (!user) throw new InternalServerErrorException();

    user.password = await bcrypt.hash(newPassword, 10);
  }

  // async refreshTokens(refreshToken: string) {
  //   const now = new Date();
  //   const token = this.refreshTokens.find(
  //     (t) => t.token === refreshToken && t.expiryDate >= now,
  //   );
  //
  //   if (!token) throw new UnauthorizedException('Refresh Token is invalid');
  //
  //   return this.generateUserTokens(token.userId);
  // }

  // ═══════════════════════════════════════════════════════════════════════════
  // TOKENS
  // ═══════════════════════════════════════════════════════════════════════════

  async generateUserTokens(userId: string) {
    const accessToken = this.jwtService.sign({ userId }, { expiresIn: '10h' });
    const refreshToken = uuidv4();

    await this.storeRefreshToken(refreshToken, userId);
    return { accessToken, refreshToken };
  }

  async storeRefreshToken(token: string, userId: string): Promise<void> {
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 3);

    const existing = this.refreshTokens.findIndex((t) => t.userId === userId);
    if (existing !== -1) {
      this.refreshTokens[existing] = { token, userId, expiryDate };
    } else {
      this.refreshTokens.push({ token, userId, expiryDate });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PERMISSIONS
  // ═══════════════════════════════════════════════════════════════════════════

  // Remplacer uniquement cette méthode dans auth.service.ts
  async getUserPermissions(userId: string): Promise<Permission[]> {
    const user = this.users.find((u) => u._id === userId);
    if (!user) throw new BadRequestException('User not found');
    if (!user.roleId) return [];

    const role = await this.rolesService.getRoleById(user.roleId);
    return role.permissions;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // OTP
  // ═══════════════════════════════════════════════════════════════════════════

  private generateOtp(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  async sendSmsOtp(phoneNumber: string): Promise<void> {
    const otp = this.generateOtp();
    this.otpStorage.set(phoneNumber, otp);

    try {
      const message = await this.twilioClient.messages.create({
        body: `Votre code OTP est : ${otp}`,
        from: process.env.TWILIO_PHONE_NUMBER ?? '+13603429534',
        to: phoneNumber,
      });
      this.logger.log(`SMS OTP envoyé à ${phoneNumber} SID: ${message.sid}`);
    } catch (error) {
      this.logger.error(`Erreur envoi SMS OTP: ${error}`);
      throw new InternalServerErrorException(
        "Erreur lors de l'envoi du SMS OTP",
      );
    }
  }

  async sendWhatsappOtp(phoneNumber: string): Promise<void> {
    const otp = this.generateOtp();
    this.otpStorage.set(phoneNumber, otp);

    try {
      const message = await this.twilioClient.messages.create({
        from: 'whatsapp:+14155238886',
        to: `whatsapp:${phoneNumber}`,
        body: `Votre code OTP est : ${otp}`,
      });
      this.logger.log(
        `WhatsApp OTP envoyé à ${phoneNumber} SID: ${message.sid}`,
      );
    } catch (error) {
      this.logger.error(`Erreur envoi WhatsApp OTP: ${error.message}`);
      throw new InternalServerErrorException(
        "Erreur lors de l'envoi du WhatsApp OTP",
      );
    }
  }

  async sendEmailOtp(email: string): Promise<void> {
    const otp = this.generateOtp();
    this.otpStorage.set(email, otp);

    try {
      this.mailService.sendOtpEmail(email, otp);
    } catch (error) {
      this.logger.error(`Erreur envoi Email OTP: ${error}`);
      throw new InternalServerErrorException(
        "Erreur lors de l'envoi de l'OTP par email",
      );
    }
  }

  validateOtp(identifier: string, otp: string): boolean {
    const storedOtp = this.otpStorage.get(identifier);
    if (!storedOtp)
      throw new BadRequestException('Aucun OTP généré pour cet identifiant');
    if (storedOtp !== otp) throw new UnauthorizedException('OTP invalide');

    this.otpStorage.delete(identifier); // invalider après usage
    return true;
  }
}
