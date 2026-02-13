import {
  BadRequestException,
  Injectable,
  InternalServerErrorException, Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { SignupDto } from './dtos/signup.dto';
import { InjectModel } from '@nestjs/mongoose';
import { User } from './schemas/user.schema';
import mongoose, { Model } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import { LoginDto } from './dtos/login.dto';
import { JwtService } from '@nestjs/jwt';
import { RefreshToken } from './schemas/refresh-token.schema';
import { v4 as uuidv4 } from 'uuid';
import { nanoid } from 'nanoid';
import { ResetToken } from './schemas/reset-token.schema';
import { MailService } from 'src/services/mail.service';
import { RolesService } from 'src/roles/roles.service';

import * as Twilio from 'twilio';


@Injectable()
export class AuthService {
  private readonly twilioClient;
  private readonly logger = new Logger(AuthService.name);

  // Stockage OTP simple en mémoire (clé = numéro, valeur = otp)
  private otpStorage = new Map<string, string>();
  constructor(
    @InjectModel(User.name) private UserModel: Model<User>,
    @InjectModel(RefreshToken.name)
    private RefreshTokenModel: Model<RefreshToken>,
    @InjectModel(ResetToken.name)
    private ResetTokenModel: Model<ResetToken>,
    private jwtService: JwtService,
    private mailService: MailService,
    private rolesService: RolesService,
  ) {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    // remplace par ta vraie clé
    this.twilioClient = Twilio(accountSid, authToken);
  }

  async signup(email: string) {
    //Check if email is in use
    const emailInUse = await this.UserModel.findOne({
      email,
    });
    if (emailInUse) {
      throw new BadRequestException('Email already in use');
    }

    // Create user document and save in mongodb
    return await this.UserModel.create({
      email,
    });
  }

  async login(email: string) {
    //Find if user exists by email
    const user = await this.UserModel.findOne({ email });
    if (!user) {
      await this.signup(email);
    }
    const user1 = await this.UserModel.findOne({ email });

    //Generate JWT tokens
    const tokens = await this.generateUserTokens(user);

    console.log(user1);
    return {
      ...tokens,
      userId: await user1._id,
    };
  }

  async changePassword(userId, oldPassword: string, newPassword: string) {
    //Find the user
    const user = await this.UserModel.findById(userId);
    if (!user) {
      throw new NotFoundException('User not found...');
    }

    await user.save();
  }

  async forgotPassword(email: string) {
    //Check that user exists
    const user = await this.UserModel.findOne({ email });

    if (user) {
      //If user exists, generate password reset link
      const expiryDate = new Date();
      expiryDate.setHours(expiryDate.getHours() + 1);

      const resetToken = nanoid(64);
      await this.ResetTokenModel.create({
        token: resetToken,
        userId: user._id,
        expiryDate,
      });
      //Send the link to the user by email
      this.mailService.sendPasswordResetEmail(email, resetToken);
    }

    return { message: 'If this user exists, they will receive an email' };
  }

  async resetPassword(newPassword: string, resetToken: string) {
    //Find a valid reset token document
    const token = await this.ResetTokenModel.findOneAndDelete({
      token: resetToken,
      expiryDate: { $gte: new Date() },
    });

    if (!token) {
      throw new UnauthorizedException('Invalid link');
    }

    //Change user password (MAKE SURE TO HASH!!)
    const user = await this.UserModel.findById(token.userId);
    if (!user) {
      throw new InternalServerErrorException();
    }

    await user.save();
  }

  async refreshTokens(refreshToken: string) {
    const token = await this.RefreshTokenModel.findOne({
      token: refreshToken,
      expiryDate: { $gte: new Date() },
    });

    if (!token) {
      throw new UnauthorizedException('Refresh Token is invalid');
    }
    return this.generateUserTokens(token.userId);
  }

  async generateUserTokens(userId) {
    const accessToken = this.jwtService.sign({ userId }, { expiresIn: '10h' });
    const refreshToken = uuidv4();

    await this.storeRefreshToken(refreshToken, userId);
    return {
      accessToken,
      refreshToken,
    };
  }

  async storeRefreshToken(token: string, userId: string) {
    // Calculate expiry date 3 days from now
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 3);

    await this.RefreshTokenModel.updateOne(
      { userId },
      { $set: { expiryDate, token } },
      {
        upsert: true,
      },
    );
  }

  async getUserPermissions(userId: string) {
    const user = await this.UserModel.findById(userId);

    if (!user) throw new BadRequestException();

    const role = await this.rolesService.getRoleById(user.roleId.toString());
    return role.permissions;
  }

  // Génération d’un code OTP 6 chiffres
  private generateOtp(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  // Envoi SMS OTP
  async sendSmsOtp(phoneNumber: string): Promise<void> {
    const otp = this.generateOtp();
    this.otpStorage.set(phoneNumber, otp);
    console.log(`Sending ${phoneNumber} to ${otp}`);

    try {
      const message = await this.twilioClient.messages.create({
        body: `Votre code OTP est : ${otp}`,
        from: '+13603429534', // Ton numéro Twilio SMS
        to: phoneNumber,
      });
      this.logger.log(`SMS OTP envoyé à ${phoneNumber} SID: ${message.sid}`);
    } catch (error) {
      this.logger.error(`Erreur envoi SMS OTP: ${error}`);
      throw new InternalServerErrorException(
        'Erreur lors de l’envoi du SMS OTP',
      );
    }
  }

  // Envoi WhatsApp OTP
  async sendWhatsappOtp(phoneNumber: string): Promise<void> {
    const otp = this.generateOtp();
    this.otpStorage.set(phoneNumber, otp);

    try {
      const message = await this.twilioClient.messages.create({
        from: 'whatsapp:+14155238886', // Numéro Twilio WhatsApp
        to: `whatsapp:+21625114365`,
        body: `Votre code OTP est : ${otp}`,
      });
      this.logger.log(
        `WhatsApp OTP envoyé à ${phoneNumber} SID: ${message.sid}`,
      );
    } catch (error) {
      this.logger.error(`Erreur envoi WhatsApp OTP: ${error.message}`);
      throw new InternalServerErrorException(
        'Erreur lors de l’envoi du WhatsApp OTP',
      );
    }
  }

  async sendEmailOtp(email: string): Promise<void> {
    const otp = this.generateOtp();
    this.otpStorage.set(email, otp);
    console.log(`Sending ${email} to ${otp}`);

    try {
      this.mailService.sendOtpEmail(email, otp);
    } catch (error) {
      this.logger.error(`Erreur envoi SMS OTP: ${error}`);
      throw new InternalServerErrorException(
        'Erreur lors de l’envoi du SMS OTP',
      );
    }
  }

  // Validation OTP
  validateOtp(phoneNumber: string, otp: string): boolean {
    const storedOtp = this.otpStorage.get(phoneNumber);
    if (!storedOtp) {
      throw new BadRequestException('Aucun OTP généré pour ce numéro');
    }
    if (storedOtp !== otp) {
      throw new UnauthorizedException('OTP invalide');
    }
    const user = this.UserModel.find({}).exec();
    // Optionnel : Supprimer OTP validé pour éviter réutilisation
    this.otpStorage.delete(phoneNumber);
    return true;
  }
}




