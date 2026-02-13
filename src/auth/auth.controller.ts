import { Body, Controller, Get, Post, Put, Req, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { SignupDto } from './dtos/signup.dto';
import { LoginDto } from './dtos/login.dto';
import { RefreshTokenDto } from './dtos/refresh-tokens.dto';
import { ChangePasswordDto } from './dtos/change-password.dto';
import { AuthenticationGuard } from 'src/guards/authentication.guard';
import { ForgotPasswordDto } from './dtos/forgot-password.dto';
import { ResetPasswordDto } from './dtos/reset-password.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // @Post('signup')
  // async signUp(@Body() signupData: string) {
  //   return this.authService.signup(signupData);
  // }

  @Post('login')
  async login(@Body() email: string) {
    return this.authService.login(email);
  }

  // @Post('refresh')
  // async refreshTokens(@Body() refreshTokenDto: RefreshTokenDto) {
  //   return this.authService.refreshTokens(refreshTokenDto.refreshToken);
  // }

  @UseGuards(AuthenticationGuard)
  @Put('change-password')
  async changePassword(
    @Body() changePasswordDto: ChangePasswordDto,
    @Req() req,
  ) {
    return this.authService.changePassword(
      req.userId,
      changePasswordDto.oldPassword,
      changePasswordDto.newPassword,
    );
  }

  @Post('forgot-password')
  async forgotPassword(@Body() forgotPasswordDto: ForgotPasswordDto) {
    return this.authService.forgotPassword(forgotPasswordDto.email);
  }

  @Put('reset-password')
  async resetPassword(
    @Body() resetPasswordDto: ResetPasswordDto,
  ) {
    return this.authService.resetPassword(
      resetPasswordDto.newPassword,
      resetPasswordDto.resetToken,
    );
  }

  // --- AJOUTS OTP SMS & WhatsApp ---

  @Post('send-sms-otp')
  async sendSmsOtp(@Body() body: { phoneNumber: string }) {
    await this.authService.sendSmsOtp(body.phoneNumber);
    return { message: 'SMS OTP envoyé' };
  }

  @Post('send-whatsapp-otp')
  async sendWhatsappOtp(@Body() body: { phoneNumber: string }) {


    console.log("1111111111111111111111111");
    await this.authService.sendWhatsappOtp(body.phoneNumber);
    return { message: 'WhatsApp OTP envoyé' };
  }

  @Post('send-mail-otp')
  async sendMailOtp(@Body() body: { email: string }) {

    console.log("1111111111111111111111111111111111111111111111111111");
    await this.authService.sendEmailOtp(body.email);
    return { message: 'Email OTP envoyé' };
  }


  @Get('yesser')
  helloWorld() {
    return "hello world";
  }


  @Post('validate-otp')
  async validateOtp(@Body() body: { phoneNumber: string; otp: string }) {
    const valid = this.authService.validateOtp(body.phoneNumber, body.otp);

    if (valid) {
      return this.authService.login(body.phoneNumber);
    }

  }
}
